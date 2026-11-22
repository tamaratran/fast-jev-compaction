# fast-jev-compaction (форк для OpenCode)

Форк [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction):
тот же движок компакции «дословно», подключённый к хуку `compaction` в OpenCode.
Jev можно спросить через сам OpenCode, через TypeSafe или через локальную
Jev-совместимую модель.

[English version](README.md)

## Что делает

OpenCode сжимает длинную сессию, заменяя старые ходы пересказом модели.
Пересказ теряет детали: путь к файлу, точный текст ошибки, ограничение из
запроса.

Плагин ничего не переписывает. Каждый вызов инструмента и каждый его результат
оценивается одним запросом к Jev; ненужное удаляется или обрезается, остальное
остаётся дословно и по порядку. Хук возвращает выжившие сообщения как окно
замены (`result.native.messages`), и OpenCode переигрывает их вместо пересказа.

Если Jev недоступен, ответил мусором или удалил слишком мало, хук не выставляет
`result`, и OpenCode пишет свой обычный пересказ. Неудачная компакция не делает
сессию хуже встроенного поведения.

## Установка

```sh
git clone https://github.com/Zakhvatov/fast-jev-compaction.git \
  ~/.config/opencode/plugins/fast-jev-compaction
cd ~/.config/opencode/plugins/fast-jev-compaction
npm install --omit=dev
```

Корень репозитория и есть каталог плагина: `package.json` отдаёт
`exports["."]` → [`src/opencode/index.ts`](src/opencode/index.ts).

В `~/.config/opencode/opencode.json` (или в `opencode.json` проекта):

```jsonc
{
  "plugins": [
    {
      "package": "/Users/you/.config/opencode/plugins/fast-jev-compaction",
      "options": { "transport": "opencode-free" }
    }
  ]
}
```

Перезапустить OpenCode. Каталог `.opencode/plugins/fast-jev-compaction/` в
проекте тоже подходит и не требует записи в `plugins`.

## Какая именно Jev

`jev-1.13-free` и `jev-1.13` отдаёт подключение к OpenCode Console (провайдер
`opencode`), а не подписка Go. Бесплатный уровень стоит ноль, платный
тарифицируется в долларах за вызов.

| Пресет | Транспорт | Что нужно |
| --- | --- | --- |
| `opencode-free` (по умолчанию) | провайдер `opencode`, модель `jev-1.13-free` | подключённый провайдер `opencode` |
| `opencode-paid` | провайдер `opencode`, модель `jev-1.13` | то же, платно за вызов |
| `typesafe` | HTTP, `api.typesafe.ai/v1/systemone`, `jev-latest` | `TYPESAFE_API_KEY` |
| `opencode-http-free` | HTTP, `opencode.ai/inference/systemone` | ключ Console в `auth.json` |
| `opencode-go-free` | HTTP, `opencode.ai/inference/go/systemone` | ключ, `x-opencode-session` и модель в тарифе Go |
| `openjev` | `http://127.0.0.1:8009/v1/systemone` | запущенный OpenJev |

Любой другой сервер задаётся через `baseUrl` и `model`; локальному адресу ключ
не нужен. `contextWindow`, `maxCallsPerBatch` и `maxConcurrentRequests` держат
локальную модель в её окне и в той памяти, которая реально есть.

Внутри OpenCode запрос идёт через `ctx.experimental.generate.decisions` и
подписывается тем провайдером, который подключил пользователь. Вне OpenCode
(бенч) та же модель вызывается по HTTP с ключом из
`~/.local/share/opencode/auth.json`.

Неудачный запрос не портит сессию: плагин не выставляет результат, журнал
записывает ошибку, а OpenCode пишет свой обычный пересказ.

## Настройки

| Опция | По умолчанию | Что делает |
| --- | --- | --- |
| `transport` / `preset` | `opencode-free` | имя пресета или URL (`http://…/v1/systemone`) |
| `baseUrl` | — | явно выбрать HTTP-транспорт |
| `model` | из пресета | имя модели для HTTP |
| `apiKey` | env или `auth.json` | ключ для HTTP |
| `providerID`, `modelID` | `opencode`, `jev-1.13-free` | явно выбрать провайдер |
| `contextWindow` | — | полный бюджет запроса локальной модели |
| `maxStateTokens` | `25000` | потолок состояния, которое видит Jev |
| `maxRequestTokens` | `30000` | потолок состояния вместе с вопросами |
| `maxCallsPerBatch` | `0` | вызовов на запрос; 0 — все вызовы одним запросом |
| `maxConcurrentRequests` | `0` | сколько запросов одновременно; 0 — все сразу |
| `keepThreshold` | `0.5` | минимальная вероятность «оставить» |
| `preserveRecentMessages` | `6` | сколько последних сообщений не трогать (первое не трогается всегда) |
| `truncateHeadChars` | `300` | сколько символов результата оставить перед пометкой |
| `minReductionRatio` | `0.25` | ниже этой доли остаётся встроенный пересказ |
| `logPath` | `~/.local/share/opencode/fast-jev-compaction/trial.jsonl` | журнал попыток |
| `enabled` | `true` | выключить плагин, не удаляя его |

Переменные окружения: `FAST_JEV_TRANSPORT`, `FAST_JEV_BASE_URL`,
`FAST_JEV_MODEL`, `FAST_JEV_API_KEY`, `FAST_JEV_CONTEXT_WINDOW`,
`FAST_JEV_PROVIDER`, `FAST_JEV_MODEL_ID`, `FAST_JEV_LOG`, `FAST_JEV_ENABLED`,
`FAST_JEV_CHAT_MODEL`.

## Как понять, лучше стало или хуже

Три уровня, потому что вопросы разные.

### 1. Размеченные кейсы

[`bench/cases/core.json`](bench/cases/core.json) — транскрипты, где правильное
решение известно: устаревшее чтение файла, вывод упавшего теста, который нужен
дальше, ограничение из текста пользователя (его не трогают), лог сборки с
ошибкой компиляции, повторное чтение файла, где старая копия устарела.

```sh
tsx bench/run.ts --transport stub        # проверка механики без сети
tsx bench/run.ts --transport opencode-http-free --verbose
tsx bench/run.ts --transport opencode-http-free --limit 5
```

Метрики по важности:

- **dangerous** — удалили или обрезали результат, который понадобился дальше;
- **lost probes** — дословный факт, который использовал следующий ход, пропал
  из окна;
- **reduction** — доля удалённых символов; без неё смысла нет.

### 2. Реальные сессии

```sh
tsx bin/extract-sessions.ts --limit 10
```

Скрипт читает `~/.local/share/opencode/opencode.db`, находит последний ход
ассистента в сессии и считает зондами всё, что этот ход использовал: открытый
файл, запущенную команду, процитированную строку ошибки. Если зонд лежал в
результате инструмента из истории, значит результат понадобился позже, и его
удаление — опасное решение. Дальше это обычные кейсы для `bench/run.ts`.

### 3. Сквозная проверка

```sh
tsx bench/e2e.ts --transport opencode-http-free --baseline --ask
```

Для каждого фикстура:

- остался ли зонд в окне;
- остался ли он в пересказе той же истории, написанном моделью (`--baseline`,
  один вызов чата на фикстур);
- может ли модель процитировать его из окна и из пересказа (`--ask`, один
  вызов на зонд).

Модель по умолчанию — `deepseek-v4.1-flash` через Go-маршрут; меняется через
`FAST_JEV_CHAT_MODEL` или `--chat-model`.

### 4. Журнал попыток

Каждая компакция добавляет строку JSON в `logPath`: транспорт, счётчики,
решения, доля удалённого, стадия сжатия состояния, задержка и текст ошибки.
Содержимое транскрипта не пишется.

```sh
tsx bin/trial.ts
tsx bin/trial.ts --since 2026-11-20
```

## Как принимаются решения

1. `tool_use` и `tool_result` связываются по id. Вызовы в первом сообщении и в
   последних `preserveRecentMessages` не трогаются.
2. Состояние — вся переписка, от старых к новым, с результатами, заменёнными
   короткой пометкой (`ok, 4213 chars (omitted)`); оно ужимается под
   `maxStateTokens` стадиями. Если не помещается — компакция падает, и OpenCode
   пишет свой пересказ.
3. По каждому вызову два вопроса `noul`: нужен ли сам вызов и нужен ли его
   результат дословно. Запросы пачками под `maxRequestTokens`, параллельно.
4. `keepResult ≥ threshold` — оставить; иначе `keepCall ≥ threshold` — оставить
   вызов и обрезать результат; иначе удалить вызов вместе с результатом. Текст
   сообщений не удаляется никогда.

Движок по-прежнему доступен как библиотека: после `npm run build` —
`import { compact } from 'fast-jev-compaction/lib'`.

## Разработка

```sh
npm run typecheck
npm test
npm run build
npm run bench:stub
npm run bench:stub-server
```

`npm install` использует `.npmrc` с `legacy-peer-deps`: у `@opencode/plugin` и
vitest расходятся требования к версии vite.

## Происхождение

Движок и исходный README — из
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction).
В форке интеграция с хостом заменена плагином для OpenCode, добавлены реестр
транспортов, поддержка локальных моделей и бенч. MIT.
