# CI Ingress Provider Infrastructure - Terraform Configuration
#
# This Terraform configuration deploys CI Ingress VPS with WireGuard + Caddy
# for custom tunnel ingress as an alternative to Cloudflare Tunnel.
#
# Architecture:
#   Browser → Cloudflare DNS/CDN → CI Ingress VPS (Caddy) → WireGuard → CI-Hub → Apps
#
# Usage:
#   terraform init
#   terraform plan
#   terraform apply

terraform {
  required_version ">= 1.0"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

# ============================================================================
# Variables
# ============================================================================

variable "do_token" {
  description = "DigitalOcean API token"
  type        = string
  sensitive   = true
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token"
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Cloudflare Zone ID for your domain"
  type        = string
}

variable "domain" {
  description = "Root domain for CI Ingress (e.g., ci.computer)"
  type        = string
}

variable "ingress_subdomain" {
  description = "Subdomain for ingress endpoint (e.g., ingress-us-west)"
  type        = string
  default     = "ingress-us-west"
}

variable "wireguard_subdomain" {
  description = "Subdomain for WireGuard endpoint (e.g., wg-us-west)"
  type        = string
  default     = "wg-us-west"
}

variable "region" {
  description = "DigitalOcean region"
  type        = string
  default     = "nyc3"
}

variable "droplet_size" {
  description = "DigitalOcean droplet size"
  type        = string
  default     = "s-2vcpu-4gb"
}

variable "ssh_key_ids" {
  description = "List of SSH key IDs to add to droplets"
  type        = list(number)
}

variable "admin_email" {
  description = "Admin email for Let's Encrypt certificates"
  type        = string
}

variable "wireguard_network" {
  description = "WireGuard network CIDR"
  type        = string
  default     = "10.44.0.0/24"
}

variable "wireguard_server_ip" {
  description = "WireGuard server IP within the network"
  type        = string
  default     = "10.44.0.1"
}

# ============================================================================
# Providers
# ============================================================================

provider "digitalocean" {
  token = var.do_token
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# ============================================================================
# Firewall
# ============================================================================

resource "digitalocean_firewall" "ci_ingress" {
  name = "ci-ingress-firewall"

  droplet_ids = [digitalocean_droplet.ci_ingress.id]

  # SSH access
  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # HTTP (redirect to HTTPS)
  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # HTTPS
  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # WireGuard
  inbound_rule {
    protocol         = "udp"
    port_range       = "51820"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # Allow all outbound
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

# ============================================================================
# Droplet
# ============================================================================

resource "digitalocean_droplet" "ci_ingress" {
  name   = "ci-ingress-${var.region}"
  region = var.region
  size   = var.droplet_size
  image  = "ubuntu-22-04-x64"

  ssh_keys = var.ssh_key_ids

  user_data = templatefile("${path.module}/cloud-init.sh", {
    ingress_domain     = "${var.ingress_subdomain}.${var.domain}"
    admin_email        = var.admin_email
    wireguard_network  = var.wireguard_network
    wireguard_server_ip = var.wireguard_server_ip
  })

  tags = [
    "ci-ingress",
    "ci-hub",
    var.region
  ]
}

# ============================================================================
# Cloudflare DNS
# ============================================================================

# HTTPS ingress endpoint (proxied through Cloudflare)
resource "cloudflare_record" "ingress" {
  zone_id = var.cloudflare_zone_id
  name    = var.ingress_subdomain
  type    = "A"
  value   = digitalocean_droplet.ci_ingress.ipv4_address
  proxied = true
  ttl     = 1
}

# Wildcard for user apps (proxied through Cloudflare)
resource "cloudflare_record" "wildcard" {
  zone_id = var.cloudflare_zone_id
  name    = "*.users"
  type    = "CNAME"
  value   = "${var.ingress_subdomain}.${var.domain}"
  proxied = true
  ttl     = 1
}

# WireGuard endpoint (DNS only, not proxied)
resource "cloudflare_record" "wireguard" {
  zone_id = var.cloudflare_zone_id
  name    = var.wireguard_subdomain
  type    = "A"
  value   = digitalocean_droplet.ci_ingress.ipv4_address
  proxied = false
  ttl     = 300
}

# ============================================================================
# Outputs
# ============================================================================

output "ingress_url" {
  description = "CI Ingress HTTPS URL (proxied through Cloudflare)"
  value       = "https://${var.ingress_subdomain}.${var.domain}"
}

output "wireguard_endpoint" {
  description = "WireGuard endpoint (DNS only, not proxied)"
  value       = "${var.wireguard_subdomain}.${var.domain}:51820"
}

output "vps_ip" {
  description = "VPS public IP address"
  value       = digitalocean_droplet.ci_ingress.ipv4_address
}

output "wireguard_server_ip" {
  description = "WireGuard server IP (private network)"
  value       = var.wireguard_server_ip
}

output "wireguard_server_public_key" {
  description = "WireGuard server public key (retrieve from VPS)"
  value       = "ssh root@${digitalocean_droplet.ci_ingress.ipv4_address} 'cat /etc/wireguard/publickey'"
}

output "ssh_command" {
  description = "SSH command to access VPS"
  value       = "ssh root@${digitalocean_droplet.ci_ingress.ipv4_address}"
}

output "dns_records" {
  description = "Cloudflare DNS records created"
  value = {
    ingress   = "${var.ingress_subdomain}.${var.domain} → ${digitalocean_droplet.ci_ingress.ipv4_address} (proxied)"
    wildcard  = "*.users.${var.domain} → ${var.ingress_subdomain}.${var.domain} (proxied)"
    wireguard = "${var.wireguard_subdomain}.${var.domain} → ${digitalocean_droplet.ci_ingress.ipv4_address} (DNS only)"
  }
}

output "next_steps" {
  description = "Next steps after deployment"
  value = <<-EOT
    ✅ CI Ingress VPS deployed successfully!

    Next steps:
    1. SSH into the VPS to get WireGuard public key:
       ssh root@${digitalocean_droplet.ci_ingress.ipv4_address}
       cat /etc/wireguard/publickey

    2. Test the ingress endpoint:
       curl -I https://${var.ingress_subdomain}.${var.domain}/health

    3. Configure CI-Portal environment:
       CI_INGRESS_API_URL=https://${var.ingress_subdomain}.${var.domain}

    4. Register CI-Hub devices:
       TUNNEL_PROVIDER=ci-ingress
       CI_INGRESS_API_URL=https://${var.ingress_subdomain}.${var.domain}

    5. Monitor logs on VPS:
       ssh root@${digitalocean_droplet.ci_ingress.ipv4_address}
       journalctl -u ci-ingress-api -f
       journalctl -u caddy -f
       wg show
  EOT
}
