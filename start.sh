#!/bin/sh
if [ -n "$WIREGUARD_PRIVATE_KEY" ]; then
  echo "Variabili VPN trovate, genero configurazione per Wireproxy..."
  cat <<EOF > /tmp/wireproxy.conf
[Interface]
Address = ${WIREGUARD_ADDRESSES}
PrivateKey = ${WIREGUARD_PRIVATE_KEY}
DNS = ${WIREGUARD_DNS}

[Peer]
PublicKey = ${WIREGUARD_PUBLIC_KEY}
PresharedKey = ${WIREGUARD_PRESHARED_KEY}
Endpoint = ${VPN_ENDPOINT_IP}:${VPN_ENDPOINT_PORT}
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25

[HttpProxy]
BindAddress = 127.0.0.1:8118
EOF

  echo "Avvio Wireproxy in background..."
  /usr/local/bin/wireproxy -c /tmp/wireproxy.conf &

  export PROXY_URL="http://127.0.0.1:8118"
  sleep 4
else
  echo "Nessuna configurazione VPN trovata, avvio diretto."
fi

echo "Avvio StreamFusion Mail..."
exec node server.js
