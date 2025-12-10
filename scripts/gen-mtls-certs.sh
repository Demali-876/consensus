cd ~/Desktop/consensus/scripts

mkdir -p mtls-certs
cd mtls-certs

# 1. Create a private CA
openssl genrsa -out ca.key 4096
openssl req -new -x509 -days 3650 -key ca.key -out ca.crt \
  -subj "/C=US/ST=State/L=City/O=Consensus/CN=Consensus CA"

# 2. Create server certificate (for main-server)
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr \
  -subj "/C=US/ST=State/L=City/O=Consensus/CN=consensus.canister.software"

# Sign it with our CA
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out server.crt -days 3650

# 3. Create client certificate (for x402-proxy)
openssl genrsa -out client.key 2048
openssl req -new -key client.key -out client.csr \
  -subj "/C=US/ST=State/L=City/O=Consensus/CN=consensus-proxy"

# Sign it with our CA
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out client.crt -days 3650

# Clean up CSRs
rm *.csr

# Set permissions
chmod 600 *.key
chmod 644 *.crt