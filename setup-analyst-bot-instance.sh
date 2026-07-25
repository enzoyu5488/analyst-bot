#!/usr/bin/env bash

set -Eeuo pipefail

###############################################################################
# Devbox Ari Analyst Bot - Ubuntu EC2 Provisioning Script
#
# Defaults:
#   Branch:       main
#   Application:  /home/ubuntu/analyst-bot
#   Node.js:      20
#   App port:     3101
#   PM2 process:  analyst-bot
#
# No NAT/iptables redirect is configured. The app listens directly on APP_PORT.
#
# Usage:
#   chmod +x setup-analyst-bot-instance.sh
#   ./setup-analyst-bot-instance.sh
#
# Optional overrides:
#   REPO_URL=https://github.com/you/analyst-bot.git BRANCH=main APP_PORT=3101 \
#     ./setup-analyst-bot-instance.sh
###############################################################################

REPO_URL="${REPO_URL:-https://github.com/enzoyu5488/analyst-bot.git}"
BRANCH="${BRANCH:-main}"
APP_NAME="${APP_NAME:-analyst-bot}"
APP_DIR="${APP_DIR:-$HOME/analyst-bot}"
APP_PORT="${APP_PORT:-3101}"
NODE_VERSION="${NODE_VERSION:-20}"
NVM_VERSION="${NVM_VERSION:-v0.40.4}"

log() {
    printf '\n============================================================\n'
    printf '%s\n' "$1"
    printf '============================================================\n'
}

fail() {
    printf '\nERROR: %s\n' "$1" >&2
    exit 1
}

on_error() {
    local exit_code=$?
    local line_number=$1
    printf '\nSetup failed on line %s with exit code %s.\n' "$line_number" "$exit_code" >&2
    exit "$exit_code"
}

trap 'on_error $LINENO' ERR

if [[ "$EUID" -eq 0 ]]; then
    fail "Run this script as the ubuntu user, not root."
fi

log "Checking user and sudo"

echo "Current user: $(whoami)"
echo "Home folder:  $HOME"

if ! command -v sudo >/dev/null 2>&1; then
    fail "sudo is not installed."
fi

if ! sudo -n true >/dev/null 2>&1; then
    fail "Passwordless sudo is required. 'sudo -n true' failed."
fi

log "Installing Ubuntu packages"

sudo -n apt-get update
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential \
    ca-certificates \
    curl \
    git \
    wget

if ! command -v gh >/dev/null 2>&1; then
    log "Installing GitHub CLI"

    sudo -n mkdir -p -m 755 /etc/apt/keyrings
    wget -nv -O /tmp/githubcli-archive-keyring.gpg \
        https://cli.github.com/packages/githubcli-archive-keyring.gpg
    sudo -n cp /tmp/githubcli-archive-keyring.gpg \
        /etc/apt/keyrings/githubcli-archive-keyring.gpg
    sudo -n chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg

    sudo -n mkdir -p -m 755 /etc/apt/sources.list.d
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        | sudo -n tee /etc/apt/sources.list.d/github-cli.list >/dev/null

    sudo -n apt-get update
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y gh
fi

echo "gh: $(gh --version | head -n1)"

log "GitHub authentication"

if gh auth status >/dev/null 2>&1; then
    echo "Already authenticated as $(gh api user --jq .login 2>/dev/null || echo 'unknown user')."
else
    echo "If ${REPO_URL} is private, paste a GitHub token with repo read access."
    echo "Leave blank to skip if the repo is public."
    echo

    read -r -s -p "GitHub token (or blank to skip): " GITHUB_TOKEN
    echo

    if [[ -n "$GITHUB_TOKEN" ]]; then
        echo "$GITHUB_TOKEN" | gh auth login --hostname github.com --git-protocol https --with-token
        gh auth setup-git
        echo "Authenticated as: $(gh api user --jq .login 2>/dev/null || echo 'unknown user')"
    else
        echo "Skipping gh auth login; relying on plain git clone/fetch."
    fi
    unset GITHUB_TOKEN
fi

log "Installing NVM ${NVM_VERSION}"

export NVM_DIR="$HOME/.nvm"

if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
fi

if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    fail "NVM installation failed."
fi

# shellcheck disable=SC1090
source "$NVM_DIR/nvm.sh"

log "Installing Node.js ${NODE_VERSION}"

nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION"
nvm use "$NODE_VERSION"

echo "Node: $(node --version)"
echo "npm:  $(npm --version)"

log "Installing PM2"

npm install --global pm2

echo "PM2: $(pm2 --version)"

log "Preparing analyst-bot repository"

if [[ -d "$APP_DIR/.git" ]]; then
    echo "Existing repository found at $APP_DIR"

    sudo -n chown -R "$(id -un):$(id -gn)" "$APP_DIR"
    git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

    cd "$APP_DIR"
    git remote set-url origin "$REPO_URL"
    git fetch origin "$BRANCH"

    if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
        git checkout "$BRANCH"
    else
        git checkout -b "$BRANCH" "origin/$BRANCH"
    fi

    git reset --hard "origin/$BRANCH"
elif [[ -e "$APP_DIR" ]]; then
    fail "$APP_DIR exists but is not a Git repository."
else
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
    cd "$APP_DIR"
fi

log "Validating application files"

cd "$APP_DIR"

if [[ ! -f package.json ]]; then
    fail "package.json was not found in $APP_DIR."
fi

if [[ ! -f server.js ]]; then
    fail "server.js was not found in $APP_DIR."
fi

mkdir -p "$APP_DIR/data" "$APP_DIR/uploads"

log "Preparing .env"

if [[ -f .env ]]; then
    echo "Existing .env found at $APP_DIR/.env -- leaving it untouched."
else
    if [[ ! -f .env.example ]]; then
        fail ".env.example was not found in $APP_DIR; cannot seed .env."
    fi

    SESSION_SECRET_GENERATED="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"

    cp .env.example .env
    sed -i "s#^PORT=.*#PORT=${APP_PORT}#" .env
    sed -i "s#^SESSION_SECRET=.*#SESSION_SECRET=${SESSION_SECRET_GENERATED}#" .env
    sed -i "s#^ORG_SLUG=.*#ORG_SLUG=devboxph#" .env
    chmod 600 .env

    echo "Created $APP_DIR/.env from .env.example with a generated SESSION_SECRET."
    echo
    echo "*** ACTION REQUIRED ***"
    echo "Edit $APP_DIR/.env and fill in the real values before relying on the app:"
    echo "  OPENAI_API_KEY"
    echo "  ARI_PUBLIC_BASE_URL"
    echo "  LEX_API_BASE_URL / LEX_API_TOKEN"
    echo "  MONGODB_URI / MONGODB_DB_NAME / MONGODB_STORIES_COLLECTION"
    echo "  MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET / MICROSOFT_TENANT_ID (if using SSO)"
    echo "Then run: pm2 restart ${APP_NAME} --update-env"
fi

log "Installing npm dependencies"

if [[ -f package-lock.json ]]; then
    npm ci || npm install
else
    npm install
fi

log "Starting analyst-bot on port ${APP_PORT}"

export PORT="$APP_PORT"

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 restart "$APP_NAME" --update-env
else
    pm2 start server.js \
        --name "$APP_NAME" \
        --cwd "$APP_DIR" \
        --update-env
fi

pm2 save

log "Enabling PM2 startup after reboot"

NODE_BIN_DIR="$(dirname "$(command -v node)")"
PM2_PATH="$(command -v pm2)"

sudo -n env \
    PATH="$NODE_BIN_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$PM2_PATH" \
    startup systemd \
    -u "$(whoami)" \
    --hp "$HOME"

pm2 save

log "Running basic checks"

pm2 status

echo
echo "Listening ports:"
sudo -n ss -lntp | grep -E ":${APP_PORT}\b" || true

echo
echo "Testing the application locally on port ${APP_PORT}:"

set +e
curl \
    --silent \
    --show-error \
    --max-time 10 \
    -o /dev/null \
    -w "HTTP %{http_code}\n" \
    "http://127.0.0.1:${APP_PORT}/"
CURL_STATUS=$?
set -e

echo

if [[ "$CURL_STATUS" -ne 0 ]]; then
    echo "The local HTTP check did not succeed."
    echo "Review the PM2 logs and confirm the application uses PORT=${APP_PORT}."
fi

log "analyst-bot setup completed"

cat <<EOF
Repository:          $REPO_URL
Branch:              $BRANCH
Application folder:  $APP_DIR
PM2 process:         $APP_NAME
Application port:    $APP_PORT
Org slug:            devboxph

Useful commands:

  pm2 status
  pm2 logs $APP_NAME
  pm2 restart $APP_NAME --update-env
  pm2 stop $APP_NAME
  cd $APP_DIR
  git status

.env lives at $APP_DIR/.env (created from .env.example on first run if it
didn't exist, left untouched on reruns). To change values or rotate
secrets later:
  \$EDITOR $APP_DIR/.env
  pm2 restart $APP_NAME --update-env

No NAT redirect was configured. Ensure the instance security group,
reverse proxy, ALB, or portal shell can reach port $APP_PORT.
EOF
