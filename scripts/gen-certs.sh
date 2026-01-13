#!/usr/bin/env bash
set -euo pipefail

DOMAIN_MAIN="consensus.canister.software"
DOMAIN_PROXY="consensus.proxy.canister.software"
LOCAL_CERT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/certs"
ACME_HOME="${ACME_HOME:-$HOME/.acme.sh}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_cert_info() {
    local crt="$1"
    echo
    echo "=== Certificate info for ${DOMAIN_MAIN} ==="
    openssl x509 -in "$crt" -noout \
        -subject \
        -issuer \
        -dates \
        -ext subjectAltName 2>/dev/null || true
    echo "=========================================="
    echo
    
    local expiry_date
    expiry_date=$(openssl x509 -in "$crt" -noout -enddate | cut -d= -f2)
    local expiry_epoch
    expiry_epoch=$(date -d "$expiry_date" +%s 2>/dev/null || echo "0")
    local now_epoch
    now_epoch=$(date +%s)
    local days_left=$(( (expiry_epoch - now_epoch) / 86400 ))
    
    if [ "$days_left" -lt 30 ] && [ "$days_left" -gt 0 ]; then
        echo -e "${YELLOW}⚠️  WARNING: Certificate expires in ${days_left} days!${NC}"
        return 1
    elif [ "$days_left" -le 0 ]; then
        echo -e "${RED}❌ ERROR: Certificate is EXPIRED!${NC}"
        return 2
    else
        echo -e "${GREEN}✅ Certificate valid for ${days_left} more days${NC}"
        return 0
    fi
}

sync_certificates() {
    # Try _ecc directory first (default for newer acme.sh), then regular
    local acme_cert_dir="$ACME_HOME/${DOMAIN_MAIN}_ecc"
    if [ ! -d "$acme_cert_dir" ]; then
        acme_cert_dir="$ACME_HOME/${DOMAIN_MAIN}"
    fi
    
    if [ ! -d "$acme_cert_dir" ]; then
        echo -e "${RED}Error: Certificate not found at ${acme_cert_dir}${NC}"
        echo "Expected location: $acme_cert_dir"
        exit 1
    fi
    
    echo -e "${BLUE}Syncing certificates from acme.sh → ${LOCAL_CERT_DIR}${NC}"
    mkdir -p "$LOCAL_CERT_DIR"
    
    # Backup existing certs if they exist
    if [ -f "${LOCAL_CERT_DIR}/main.crt" ]; then
        BACKUP_DIR="${LOCAL_CERT_DIR}/backup-$(date +%Y%m%d-%H%M%S)"
        mkdir -p "$BACKUP_DIR"
        cp "${LOCAL_CERT_DIR}"/*.key "${LOCAL_CERT_DIR}"/*.crt "$BACKUP_DIR/" 2>/dev/null || true
        echo -e "${GREEN}Previous certificates backed up to: $BACKUP_DIR${NC}"
    fi
    
    # Clean up old certs
    rm -f "${LOCAL_CERT_DIR:?}"/*.key "${LOCAL_CERT_DIR:?}"/*.crt
    
    # Main certs
    cp "${acme_cert_dir}/${DOMAIN_MAIN}.key" "${LOCAL_CERT_DIR}/main.key"
    cp "${acme_cert_dir}/fullchain.cer" "${LOCAL_CERT_DIR}/main.crt"
    cp "${acme_cert_dir}/ca.cer" "${LOCAL_CERT_DIR}/ca.crt"
    
    # Proxy certs (same cert, different filenames)
    cp "${acme_cert_dir}/${DOMAIN_MAIN}.key" "${LOCAL_CERT_DIR}/proxy.key"
    cp "${acme_cert_dir}/fullchain.cer" "${LOCAL_CERT_DIR}/proxy.crt"
    
    chmod 600 "${LOCAL_CERT_DIR}"/*.key
    chmod 644 "${LOCAL_CERT_DIR}"/*.crt
    
    echo -e "${GREEN}Done. Local certs are now:${NC}"
    ls -lh "${LOCAL_CERT_DIR}"
    
    print_cert_info "${LOCAL_CERT_DIR}/main.crt"
    
    # Verify the certificate is valid for both domains
    echo "Verifying domains in certificate..."
    if openssl x509 -in "${LOCAL_CERT_DIR}/main.crt" -noout -text | grep -q "$DOMAIN_MAIN" && \
       openssl x509 -in "${LOCAL_CERT_DIR}/main.crt" -noout -text | grep -q "$DOMAIN_PROXY"; then
        echo -e "${GREEN}✅ Both domains present in certificate${NC}"
    else
        echo -e "${RED}⚠️  WARNING: Check that both domains are in the certificate!${NC}"
    fi
}

renew_certificate() {
    echo -e "${BLUE}Renewing certificate...${NC}"
    
    if [ ! -f "$ACME_HOME/acme.sh" ]; then
        echo -e "${RED}Error: acme.sh not found at $ACME_HOME${NC}"
        exit 1
    fi
    
    source "$ACME_HOME/acme.sh.env"
    
    "$ACME_HOME/acme.sh" --renew -d "$DOMAIN_MAIN" --force
    
    echo -e "${GREEN}Renewal complete!${NC}"
}

show_info() {
    # Try _ecc directory first
    ACME_CERT_DIR="$ACME_HOME/${DOMAIN_MAIN}_ecc"
    if [ ! -d "$ACME_CERT_DIR" ]; then
        ACME_CERT_DIR="$ACME_HOME/${DOMAIN_MAIN}"
    fi
    
    if [ -f "$ACME_CERT_DIR/fullchain.cer" ]; then
        print_cert_info "$ACME_CERT_DIR/fullchain.cer"
    else
        echo -e "${RED}No certificate found at $ACME_CERT_DIR${NC}"
        exit 1
    fi
}

show_help() {
    echo "Usage: $0 [COMMAND]"
    echo
    echo "Commands:"
    echo "  --renew      Force renew certificate and sync"
    echo "  --sync       Sync certificates from acme.sh to local certs/ directory (default)"
    echo "  --info       Show certificate information"
    echo "  --help       Show this help message"
    echo
    echo "Examples:"
    echo "  $0                      # Sync certificates to local directory"
    echo "  $0 --renew              # Renew certificate and sync"
    echo "  $0 --info               # Check certificate expiration"
}

# Main command handling
case "${1:-sync}" in
    --renew)
        renew_certificate
        sync_certificates
        ;;
    --sync|sync)
        sync_certificates
        ;;
    --info)
        show_info
        ;;
    --help|-h)
        show_help
        ;;
    *)
        echo -e "${RED}Unknown command: $1${NC}"
        echo
        show_help
        exit 1
        ;;
esac