#!/usr/bin/env bash
set -euo pipefail

echo "Installing acme.sh..."

# Install acme.sh
if [ ! -d "$HOME/.acme.sh" ]; then
    curl https://get.acme.sh | sh -s email=admin@canister.software
    source "$HOME/.acme.sh/acme.sh.env"
else
    echo "acme.sh already installed"
fi

# Create config directory
mkdir -p "$HOME/.acme.sh/account.conf.d"

echo
echo "==================================="
echo "acme.sh installation complete!"
echo "==================================="
echo
echo "Next steps:"
echo "1. Get your Namecheap API credentials from:"
echo "   https://ap.www.namecheap.com/settings/tools/apiaccess/"
echo
echo "2. Add to your ~/.bashrc or ~/.zshrc:"
echo "   export NAMECHEAP_USERNAME='your_username'"
echo "   export NAMECHEAP_API_KEY='your_api_key'"
echo "   export NAMECHEAP_SOURCEIP='$(curl -s https://api.ipify.org)'"
echo
echo "3. Then run: source ~/.bashrc"
echo "4. Finally run: ./gen-certs.sh --issue"