cd ~/Desktop/consensus/scripts
mkdir -p mtls-certs
cd mtls-certs

# 1. Create a private CA
openssl genrsa -out ca.key 4096
openssl req -new -x509 -days 3650 -key ca.key -out ca.crt \
  -subj "/C=US/ST=State/L=City/O=Consensus/CN=Consensus CA"

# 2. Create server certificate (for main-server) WITH SANs
# First create a config file for SANs
cat > server-san.cnf << EOF
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
C = US
ST = State
L = City
O = Consensus
CN = consensus.canister.software

[v3_req]
keyUsage = keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = consensus.canister.software
DNS.2 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
EOF

# Generate server key and CSR with SANs
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr -config server-san.cnf

# Sign it with our CA (with SANs)
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out server.crt -days 3650 -sha256 \
  -extensions v3_req -extfile server-san.cnf

# 3. Create client certificate (for x402-proxy)
openssl genrsa -out client.key 2048
openssl req -new -key client.key -out client.csr \
  -subj "/C=US/ST=State/L=City/O=Consensus/CN=consensus-proxy"

# Sign it with our CA
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out client.crt -days 3650

# Clean up CSRs and config
rm *.csr server-san.cnf

# Set permissions
chmod 600 *.key
chmod 644 *.crt