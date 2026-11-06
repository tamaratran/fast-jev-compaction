#!/usr/bin/env python3
"""LoRA fine-tune Qwen3.5-0.8B on distilled compaction decisions.

Uses transformers + peft + QLoRA. Matches tev1's recipe (LoRA r=8, alpha=16,
lr=5e-5, cosine schedule, 1 epoch). Computes loss only on answer tokens to
avoid materializing the full 152K-vocab logits sequence.

Usage:
    /path/to/train-venv/bin/python tools/distill/train.py \
        --data data/distill-v1/sft \
        --output runs/distill-0.8b-v1 \
        --base-model Qwen/Qwen3.5-0.8B
"""

import argparse
import json
import math
import time
from pathlib import Path

import torch
import torch.nn.functional as F
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, get_cosine_schedule_with_warmup
from peft import LoraConfig, get_peft_model, TaskType, prepare_model_for_kbit_training


def load_sft_data(path, tokenizer, max_seq_length=2048):
    """Load SFT JSONL. Returns (input_ids, answer_pos, answer_id, is_keep) per example."""
    examples = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            msgs = row["messages"]

            prompt = tokenizer.apply_chat_template(
                msgs[:-1], tokenize=False, add_generation_prompt=True, enable_thinking=False
            )
            completion = msgs[-1]["content"] + tokenizer.eos_token
            full_text = prompt + completion

            input_ids = tokenizer.encode(full_text, add_special_tokens=False)
            if len(input_ids) > max_seq_length:
                continue

            prompt_ids = tokenizer.encode(prompt, add_special_tokens=False)
            prompt_len = len(prompt_ids)

            answer_token_id = input_ids[prompt_len] if prompt_len < len(input_ids) else input_ids[-1]
            answer_pos = prompt_len - 1

            answer_letter = msgs[-1]["content"].strip()
            payload = json.loads(msgs[1]["content"])
            is_keep = any(o["label"] == answer_letter and o["key"] == "true" for o in payload["options"])

            examples.append({
                "input_ids": torch.tensor(input_ids, dtype=torch.long),
                "answer_pos": answer_pos,
                "answer_id": answer_token_id,
                "is_keep": is_keep,
            })

    return examples


def collate(batch, pad_id=0):
    max_len = max(len(ex["input_ids"]) for ex in batch)
    input_ids = torch.stack([
        F.pad(ex["input_ids"], (0, max_len - len(ex["input_ids"])), value=pad_id)
        for ex in batch
    ])
    attention_mask = (input_ids != pad_id).long()
    answer_pos = torch.tensor([ex["answer_pos"] for ex in batch], dtype=torch.long)
    answer_ids = torch.tensor([ex["answer_id"] for ex in batch], dtype=torch.long)
    is_keep = torch.tensor([ex["is_keep"] for ex in batch], dtype=torch.bool)
    return {"input_ids": input_ids, "attention_mask": attention_mask,
            "answer_pos": answer_pos, "answer_ids": answer_ids, "is_keep": is_keep}


def forward_loss(model, batch, device, keep_weight=1.0):
    """Forward pass computing loss only on the answer token."""
    input_ids = batch["input_ids"].to(device)
    attention_mask = batch["attention_mask"].to(device)
    answer_pos = batch["answer_pos"].to(device)
    answer_ids = batch["answer_ids"].to(device)
    is_keep = batch["is_keep"].to(device)

    outputs = model(input_ids=input_ids, attention_mask=attention_mask,
                    output_hidden_states=True, return_dict=True)

    hidden = outputs.hidden_states[-1]
    bs = hidden.size(0)
    answer_hidden = hidden[torch.arange(bs, device=device), answer_pos]

    logits = model.base_model.model.lm_head(answer_hidden.to(model.base_model.model.lm_head.weight.dtype))

    if keep_weight != 1.0:
        sample_weights = torch.where(is_keep, keep_weight, 1.0)
        per_sample_loss = F.cross_entropy(logits.float(), answer_ids, reduction="none")
        loss = (per_sample_loss * sample_weights).mean()
    else:
        loss = F.cross_entropy(logits.float(), answer_ids)
    preds = logits.argmax(dim=-1)
    correct = (preds == answer_ids).sum().item()

    return loss, correct, bs


def evaluate(model, dev_data, pad_id, device, batch_size=4):
    model.eval()
    total_loss = 0.0
    correct = 0
    total = 0

    with torch.no_grad():
        for i in range(0, len(dev_data), batch_size):
            batch = collate(dev_data[i:i + batch_size], pad_id)
            loss, c, n = forward_loss(model, batch, device)
            total_loss += loss.item() * n
            correct += c
            total += n

    model.train()
    return total_loss / max(total, 1), correct / max(total, 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base-model", default="Qwen/Qwen3.5-0.8B")
    parser.add_argument("--lora-r", type=int, default=8)
    parser.add_argument("--lora-alpha", type=int, default=16)
    parser.add_argument("--lr", type=float, default=5e-5)
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--grad-accum", type=int, default=2)
    parser.add_argument("--max-seq-length", type=int, default=1280)
    parser.add_argument("--warmup-ratio", type=float, default=0.03)
    parser.add_argument("--max-grad-norm", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--checkpoint-every", type=int, default=50, help="Save checkpoint every N steps")
    parser.add_argument("--resume", type=Path, default=None, help="Resume from checkpoint dir")
    parser.add_argument("--keep-weight", type=float, default=1.0, help="Class weight for keep examples (>1 boosts keep recall)")
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    args.output.mkdir(parents=True, exist_ok=True)

    print(f"Loading tokenizer and model: {args.base_model}")
    tokenizer = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=True)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token

    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        quantization_config=bnb_config,
        trust_remote_code=True,
        device_map={"": args.device},
    )
    model = prepare_model_for_kbit_training(model)
    model.gradient_checkpointing_enable()

    lora_config = LoraConfig(
        task_type=TaskType.CAUSAL_LM,
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=0.0,
        target_modules="all-linear",
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    print(f"Loading training data from {args.data}")
    train_data = load_sft_data(args.data / "train.jsonl", tokenizer, args.max_seq_length)
    dev_data = load_sft_data(args.data / "dev.jsonl", tokenizer, args.max_seq_length)
    print(f"Train: {len(train_data)} examples, Dev: {len(dev_data)} examples")

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.0)
    total_steps = math.ceil(len(train_data) / (args.batch_size * args.grad_accum)) * args.epochs
    warmup_steps = int(total_steps * args.warmup_ratio)
    scheduler = get_cosine_schedule_with_warmup(optimizer, warmup_steps, total_steps)

    n_keep = sum(1 for ex in train_data if ex["is_keep"])
    print(f"\nTraining: {args.epochs} epoch(s), {total_steps} steps, "
          f"batch_size={args.batch_size}, grad_accum={args.grad_accum}")
    print(f"LoRA: r={args.lora_r}, alpha={args.lora_alpha}")
    if args.keep_weight != 1.0:
        print(f"Class weighting: keep_weight={args.keep_weight} ({n_keep} keep / {len(train_data)-n_keep} drop)")

    dev_loss, dev_acc = evaluate(model, dev_data, tokenizer.pad_token_id, args.device)
    print(f"Pre-training dev: loss={dev_loss:.4f}, acc={dev_acc:.4f}")

    model.train()
    global_step = 0
    t0 = time.time()

    import random as rng
    rng.seed(args.seed)

    for epoch in range(args.epochs):
        indices = list(range(len(train_data)))
        rng.shuffle(indices)
        epoch_loss = 0.0
        epoch_n = 0
        optimizer.zero_grad()

        for i in range(0, len(indices), args.batch_size):
            batch_indices = indices[i:i + args.batch_size]
            batch = collate([train_data[j] for j in batch_indices], tokenizer.pad_token_id)

            loss, _, n = forward_loss(model, batch, args.device, keep_weight=args.keep_weight)
            scaled = loss / args.grad_accum
            scaled.backward()

            epoch_loss += loss.item() * n
            epoch_n += n

            step_in_accum = (i // args.batch_size) % args.grad_accum
            if step_in_accum == args.grad_accum - 1 or i + args.batch_size >= len(indices):
                torch.nn.utils.clip_grad_norm_(model.parameters(), args.max_grad_norm)
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad()
                global_step += 1

                if global_step % 20 == 0:
                    avg = epoch_loss / max(epoch_n, 1)
                    elapsed = time.time() - t0
                    print(f"  step {global_step}/{total_steps}, "
                          f"train_loss={avg:.4f}, "
                          f"lr={scheduler.get_last_lr()[0]:.2e}, "
                          f"elapsed={elapsed:.0f}s")

                if args.checkpoint_every and global_step % args.checkpoint_every == 0:
                    ckpt_dir = args.output / f"checkpoint-{global_step}"
                    print(f"  saving checkpoint to {ckpt_dir}")
                    model.save_pretrained(ckpt_dir)
                    tokenizer.save_pretrained(ckpt_dir)
                    torch.save({"step": global_step, "optimizer": optimizer.state_dict(),
                                "scheduler": scheduler.state_dict()}, ckpt_dir / "training_state.pt")

        avg_train_loss = epoch_loss / max(epoch_n, 1)
        dev_loss, dev_acc = evaluate(model, dev_data, tokenizer.pad_token_id, args.device)
        print(f"\nEpoch {epoch + 1}/{args.epochs}: "
              f"train_loss={avg_train_loss:.4f}, "
              f"dev_loss={dev_loss:.4f}, dev_acc={dev_acc:.4f}")

    elapsed = time.time() - t0
    print(f"\nTraining complete in {elapsed:.0f}s")

    print(f"Saving LoRA adapter to {args.output}")
    model.save_pretrained(args.output)
    tokenizer.save_pretrained(args.output)

    with open(args.output / "training_args.json", "w") as f:
        json.dump({
            "base_model": args.base_model,
            "lora_r": args.lora_r,
            "lora_alpha": args.lora_alpha,
            "lr": args.lr,
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "train_examples": len(train_data),
            "dev_examples": len(dev_data),
            "total_steps": total_steps,
            "final_dev_loss": dev_loss,
            "final_dev_acc": dev_acc,
            "elapsed_seconds": elapsed,
        }, f, indent=2)

    print("Done.")


if __name__ == "__main__":
    main()
