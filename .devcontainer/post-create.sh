#!/usr/bin/env bash
set -euo pipefail

cd /workspaces/sermonClipper

if [[ ! -f .env ]]; then
    cp .env.example .env
fi

npm ci
npm run prisma:generate

python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo "Dev container setup complete."