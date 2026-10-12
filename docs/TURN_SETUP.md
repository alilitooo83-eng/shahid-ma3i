# TURN Setup

This project supports TURN through the following environment variables:

- `TURN_URL`
- `TURN_USERNAME`
- `TURN_PASSWORD`

If these variables are not present, the client will fall back to STUN only.
If they are present, the client will use STUN + TURN.

## 1) Install Coturn on Ubuntu 22.04

```bash
sudo apt update
sudo apt install coturn -y
```

Enable the service:

```bash
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

## 2) Open required ports

Open these ports in your firewall and cloud security group:

- `3478/tcp`
- `3478/udp`
- `5349/tcp`
- `49152-65535/udp`

Example with UFW:

```bash
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 49152:65535/udp
```

## 3) Configure TLS

If you use TLS, install your certificate and configure Coturn with paths to the cert and key.
A typical setup uses `cert.pem` and `privkey.pem` plus the secure TURN port `5349`.

Example Coturn options:

```conf
tls-listening-port=5349
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
```

## 4) Create a TURN user

For static credentials:

```bash
turnadmin -a -u turnuser -p turnpassword -r example-realm
```

Or use long-term credentials in your Coturn configuration, depending on your deployment model.

## 5) Basic Coturn configuration example

```conf
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
realm=example-realm
user=turnuser:turnpassword
external-ip=YOUR_PUBLIC_IP
no-loopback-peers
no-multicast-peers
```

## 6) Test the server

Use a WebRTC test page or a TURN client to confirm connectivity.
You can also verify the server is listening:

```bash
sudo systemctl status coturn
sudo ss -lntup | grep -E '3478|5349'
```

For browser testing, set:

```env
TURN_URL=turn:turn.example.com:3478
TURN_USERNAME=turnuser
TURN_PASSWORD=turnpassword
```