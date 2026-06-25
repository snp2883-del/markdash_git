# BGS.MarkDash

Маркетинговый дашборд BGS Group. Проект Клуба Амбассадоров.

---

## Быстрый деплой на Vercel

### 1. Загрузи на GitHub
```bash
unzip markdash.zip && cd markdash
git init && git add .
git commit -m "BGS.MarkDash"
git remote add origin https://github.com/ВАШ_ЮЗЕР/markdash.git
git push -u origin main
```

### 2. Подключи Vercel
vercel.com → Add New → Project → выбери репозиторий → Framework: **Other** → Deploy

### 3. Environment Variables (Settings → Environment Variables)

#### Обязательные
| Переменная | Значение |
|---|---|
| `JWT_SECRET` | длинная случайная строка |
| `CRED__BITRIX24__WEBHOOK` | `https://your.bitrix24.ru/rest/1/xxxxx/` |
| `CRED__BITRIX24__ENTITY_TYPE` | `both` |
| `CRED__YANDEX_METRICA__TOKEN` | OAuth токен |
| `CRED__YANDEX_METRICA__COUNTER_ID` | `99208100` |

#### Медиаплан (Google Sheets)
| Переменная | Значение |
|---|---|
| `CRED__SHEETS__SPREADSHEET_ID` | ID таблицы из URL |
| `CRED__SHEETS__SHEET_GID` | `287894245` |
| `CRED__SHEETS__SHEET_NAME` | имя листа |

#### Telegram-уведомления
| Переменная | Значение |
|---|---|
| `CRED__TELEGRAM__BOT_TOKEN` | токен от @BotFather |
| `CRED__TELEGRAM__CHAT_ID` | ID чата |

#### Пользователи (опционально, есть демо-доступ)
```
USER__ADMIN__HASH   = bcrypt хэш пароля
USER__ADMIN__ROLE   = admin
USER__ADMIN__NAME   = Иван Иванов
```
Генерация хэша: `node -e "const b=require('bcryptjs');console.log(b.hashSync('пароль',10))"`

#### Прочие платформы
```
CRED__YANDEX_DIRECT__TOKEN
CRED__GOOGLE__CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN / GA4_PROPERTY_ID
CRED__LINKEDIN__ACCESS_TOKEN / ACCOUNT_ID
CRON_SECRET   (защита cron endpoint)
```

После добавления переменных → **Redeploy**

---

## Демо-доступ (без бэкенда)
- `admin` / `admin123`
- `marketing` / `market2024`
- `analyst` / `data456`

---

## Локальный запуск
```bash
npm install
cp .env.example .env   # заполни токены
node server/index.js   # → http://localhost:3000
```

---

## Статус интеграций
| Платформа | Статус |
|---|---|
| Яндекс.Метрика | ✅ Работает |
| Bitrix24 CRM | ✅ Работает |
| Google Sheets | ✅ Работает (публичная таблица или Service Account) |
| Яндекс.Директ | ⏳ Ждёт одобрения заявки |
| Google Analytics 4 | ⏳ Ждёт токенов |
| Google Ads | ⏳ Ждёт токенов |
| LinkedIn Ads | ⏳ Ждёт токенов |

---

## Архитектура
```
public/index.html     — SPA фронтенд (~6750 строк)
api/index.js          — Vercel Serverless handler (~1470 строк)
server/index.js       — Локальный Express сервер
vercel.json           — Routing + Cron (каждый час)
```

## Vercel Cron
`GET /api/cron/sync` — вызывается каждый час, синхронизирует Google Sheets и отправляет Telegram-уведомление.
