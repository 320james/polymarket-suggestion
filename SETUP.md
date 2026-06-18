# Setup Guide — Polymarket Suggestion Engine

This guide stands up the suggestion engine + dashboard on a single DigitalOcean
droplet, reachable privately from your iPhone and desktop over Tailscale (no public
exposure), with Telegram push alerts. The server only ever **reads** public Polymarket
data — there is no private key and no trade execution on the server.

---

## 0. Prerequisites (on your local machine)

- A DigitalOcean account.
- An SSH key pair. Create one if you don't have it:
  ```bash
  ssh-keygen -t ed25519 -C "polymarket-droplet"
  ```
  Add the **public** key (`~/.ssh/id_ed25519.pub`) to DigitalOcean under
  **Settings → Security → SSH Keys**.
- A free Tailscale account (sign up at tailscale.com — Google/GitHub/Apple login).
- The Tailscale app installed on your iPhone (App Store) and desktop, signed into the
  same account.

---

## 1. Create the droplet

In the DigitalOcean console: **Create → Droplets**.

- **Image:** Ubuntu 24.04 (LTS) x64
- **Plan:** Basic, Regular — the $12/mo (2 GB RAM) tier is comfortable; $6/mo (1 GB)
  works if you add swap.
- **Region:** closest to you.
- **Authentication:** SSH key (select the one you uploaded).
- **Hostname:** e.g. `polymarket-suggest`.

Create it, then note the public IP. SSH in:

```bash
ssh root@YOUR_DROPLET_IP
```

---

## 2. Basic server hardening

Create a non-root user and give it sudo:

```bash
adduser deploy            # set a password when prompted
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy   # copy your SSH key access
```

Log out and back in as `deploy`:

```bash
exit
ssh deploy@YOUR_DROPLET_IP
```

(Optional but recommended) add a 2 GB swap file on the small droplet:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 3. Tailscale (private access — no public ports)

Install Tailscale on the droplet:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Open the printed URL in a browser and authenticate. Note the droplet's Tailscale
details:

```bash
tailscale ip -4          # e.g. 100.x.y.z
tailscale status         # shows the MagicDNS name, e.g. polymarket-suggest.tailXXXX.ts.net
```

On your **iPhone** and **desktop**, open the Tailscale app and sign in with the same
account. They can now reach the droplet at its `100.x.y.z` address (or MagicDNS name)
from anywhere — no port forwarding, no public exposure.

### Firewall: keep the dashboard private

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH                 # so you don't lock yourself out
sudo ufw allow in on tailscale0        # all traffic over the tailnet
sudo ufw enable
```

With this, the dashboard port is reachable **only** over Tailscale.

---

## 4. Install Docker + Compose

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# log out and back in so the group applies:
exit
ssh deploy@YOUR_DROPLET_IP
docker compose version   # verify the Compose plugin is present
```

(If you chose the systemd/pm2 route instead of Docker, install Node 20+ via nvm here
instead — but Docker Compose is the recommended path.)

---

## 5. Create the Telegram bot + get your chat ID

1. In Telegram, search for **@BotFather** and start a chat.
2. Send `/newbot`, follow the prompts (name + username ending in `bot`).
3. BotFather replies with a **bot token** like `123456789:ABC-DEF...`. Save it as
   `TELEGRAM_BOT_TOKEN`.
4. Open a chat with **your new bot** and send it any message (e.g. "hi"). This is
   required before the bot can message you.
5. Get your chat ID — from any machine:
   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates"
   ```
   Find `"chat":{"id":<NUMBER>` in the JSON. That `<NUMBER>` is your
   `TELEGRAM_CHAT_ID`. (Alternatively, message **@userinfobot** to get your ID.)
6. Quick test:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>&text=hello"
   ```
   You should get a push notification on your phone.

---

## 6. Deploy the app

Clone your repo onto the droplet:

```bash
git clone YOUR_REPO_URL polymarket-suggest
cd polymarket-suggest
```

Create the `.env` file (this stays on the server, never committed):

```bash
cp .env.example .env
nano .env
```

Fill in:

```dotenv
# Telegram
TELEGRAM_BOT_TOKEN=123456789:ABC-DEF...
TELEGRAM_CHAT_ID=987654321

# App
DATABASE_URL=file:./data/app.db
WEB_PORT=3000
POLL_INTERVAL_SEC=120
```

> **Never** put any wallet private key in this file or on this server. This system
> does not place trades — it only reads public data.

---

## 7. Run it

```bash
docker compose up -d --build
```

Check both services are healthy:

```bash
docker compose ps
docker compose logs -f worker     # watch the first poll + vetting run
```

To apply DB migrations (if not auto-run on boot):

```bash
docker compose exec web npx prisma migrate deploy
```

---

## 8. Open the dashboard from your iPhone / desktop

With Tailscale connected on your device, browse to:

```
http://polymarket-suggest.tailXXXX.ts.net:3000
```

(or `http://100.x.y.z:3000` using the droplet's Tailscale IP). On iPhone, you can
**Add to Home Screen** in Safari to get an app-like icon.

You should see the dashboard. When a suggestion fires, you'll also get a Telegram push.

---

## 9. Day-to-day

```bash
# update to latest code
git pull && docker compose up -d --build

# tail logs
docker compose logs -f worker
docker compose logs -f web

# pause all suggestions quickly: flip the kill switch in the dashboard,
# or stop the worker:
docker compose stop worker

# restart everything
docker compose restart
```

### Troubleshooting

- **No Telegram messages:** confirm you messaged the bot first (step 5.4), and that
  the token/chat ID in `.env` match. Re-run the `sendMessage` curl test.
- **Can't reach the dashboard:** confirm Tailscale is connected on your device
  (`tailscale status`), and that `ufw allow in on tailscale0` was applied.
- **Worker rate-limited / errors on positions:** raise `POLL_INTERVAL_SEC`; the
  positions endpoint limit is 150 req / 10s, so throttle wide trader pools.
- **Empty trader stats:** ensure the worker keys positions on the **proxy** (Gnosis
  Safe) address, not the EOA — otherwise you'll see zero trades.

---

## Notes on what this is (and isn't)

- This is a **read-only analytics + suggestion** tool. It reads Polymarket's public
  Gamma and Data APIs and the public CLOB price endpoints. It places **no trades**.
- You execute trades yourself in the Polymarket app. Confirm Polymarket is available
  and permitted in your state/jurisdiction before trading — this guide is technical
  setup, not legal or financial advice.
- Keep the kill switch handy while you validate the signal in suggestion-only mode
  before risking meaningful capital.
