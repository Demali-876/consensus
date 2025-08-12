#!/usr/bin/env bash
set -euo pipefail

CERT_DIR="/etc/letsencrypt/live/consensus.canister.software"

if ! sudo test -d "$CERT_DIR"; then
    echo "Let's Encrypt certificates not found"
    echo "Run: sudo certbot certonly --manual --preferred-challenges dns -d consensus.canister.software -d consensus.proxy.canister.software"
    exit 1
fi

mkdir -p certs
rm -f certs/*

sudo cp $CERT_DIR/privkey.pem certs/main.key
sudo cp $CERT_DIR/fullchain.pem certs/main.crt
sudo cp $CERT_DIR/chain.pem certs/ca.crt

sudo cp $CERT_DIR/privkey.pem certs/proxy.key
sudo cp $CERT_DIR/fullchain.pem certs/proxy.crt

sudo chown $USER:$USER certs/*
chmod 600 certs/*.key
chmod 644 certs/*.crt

openssl x509 -in certs/main.crt -text -noout | grep -E "(Subject:|Issuer:|Not After|DNS:)"