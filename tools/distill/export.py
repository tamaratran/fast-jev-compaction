#!/usr/bin/env python3
"""Merge LoRA adapter into base model, then export to GGUF for Ollama.

Steps:
1. Load base model + LoRA adapter
2. Merge and unload LoRA
3. Save merged model in HF format
4. Convert to GGUF with llama.cpp's convert script
5. Create Ollama Modelfile

Usage:
    python tools/distill/export.py \
        --adapter runs/distill-0.8b-v1 \
        --output runs/distill-0.8b-v1-merged \
        --base-model Qwen/Qwen3.5-0.8B
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adapter", type=Path, required=True, help="LoRA adapter directory")
    parser.add_argument("--output", type=Path, required=True, help="Output directory for merged model")
    parser.add_argument("--base-model", default="Qwen/Qwen3.5-0.8B")
    parser.add_argument("--gguf-type", default="f16", choices=["f16", "q8_0", "q4_K_M"])
    parser.add_argument("--ollama-name", default="tev1-distill:0.8b")
    parser.add_argument("--skip-gguf", action="store_true", help="Only merge, skip GGUF conversion")
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)

    print(f"Loading base model: {args.base_model}")
    base_model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
        device_map="cpu",
    )
    tokenizer = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=True)

    print(f"Loading LoRA adapter: {args.adapter}")
    model = PeftModel.from_pretrained(base_model, str(args.adapter))

    print("Merging LoRA into base model...")
    model = model.merge_and_unload()

    merged_path = args.output / "merged-hf"
    print(f"Saving merged model to {merged_path}")
    model.save_pretrained(merged_path)
    tokenizer.save_pretrained(merged_path)

    if args.skip_gguf:
        print("Skipping GGUF conversion (--skip-gguf)")
        return

    gguf_path = args.output / f"tev1-distill-0.8b-{args.gguf_type}.gguf"
    print(f"\nConverting to GGUF ({args.gguf_type}): {gguf_path}")

    convert_script = None
    for candidate in [
        Path("/tmp/claude-1000/-var-home-erik/fe42fbc6-bd83-4ab3-aca6-13ceea31b305/scratchpad/llama.cpp/convert_hf_to_gguf.py"),
        Path.home() / "Projects/third-party/llama.cpp/convert_hf_to_gguf.py",
        Path("/usr/local/bin/convert_hf_to_gguf.py"),
    ]:
        if candidate.exists():
            convert_script = candidate
            break

    if convert_script is None:
        print("WARNING: llama.cpp convert script not found.")
        print(f"Run manually: python convert_hf_to_gguf.py {merged_path} --outfile {gguf_path} --outtype {args.gguf_type}")
    else:
        cmd = [sys.executable, str(convert_script), str(merged_path),
               "--outfile", str(gguf_path), "--outtype", args.gguf_type]
        print(f"Running: {' '.join(cmd)}")
        subprocess.run(cmd, check=True)
        print(f"GGUF written: {gguf_path}")

    modelfile_path = args.output / "Modelfile"
    modelfile_path.write_text(f"""FROM {gguf_path}
TEMPLATE {{{{ .Prompt }}}}
PARAMETER num_ctx 8192
PARAMETER temperature 0
PARAMETER stop <|im_end|>
""")
    print(f"\nModelfile written: {modelfile_path}")
    print(f"To register with Ollama:")
    print(f"  ollama create {args.ollama_name} -f {modelfile_path}")


if __name__ == "__main__":
    main()
