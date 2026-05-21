# Octelium Cluster Infrastructure - Terraform Configuration
#
# This Terraform configuration deploys Octelium cluster on DigitalOcean
# with Cloudflare DNS integration.
#
# Usage:
#   terraform init
#   terraform plan
#   terraform apply

terraform {
  required_version = ">= 1.0"

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
  description = "Domain name for Octelium cluster (e.g., octelium.yourdomain.com)"
  type        = string
}

variable "cluster_name" {
  description = "Octelium cluster name"
  type        = string
  default     = "ci-hub-octelium"
}

variable "admin_email" {
  description = "Admin email for Octelium cluster"
  type        = string
}

variable "region" {
  description = "DigitalOcean region"
  type        = string
  default     = "nyc3"
}

variable "node_count" {
  description = "Number of Octelium nodes to deploy"
  type        = number
  default     = 2
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

resource "digitalocean_firewall" "octelium" {
  name = "${var.cluster_name}-firewall"

  droplet_ids = digitalocean_droplet.octelium[*].id

  # SSH access
  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # HTTPS (Octelium API)
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
# Droplets
# ============================================================================

resource "digitalocean_droplet" "octelium" {
  count  = var.node_count
  name   = "${var.cluster_name}-${count.index + 1}"
  region = var.region
  size   = var.droplet_size
  image  = "ubuntu-22-04-x64"

  ssh_keys = var.ssh_key_ids

  user_data = templatefile("${path.module}/cloud-init.sh", {
    cluster_name   = var.cluster_name
    admin_email    = var.admin_email
    is_first_node  = count.index == 0
    cluster_url    = "https://${var.domain}"
    bootstrap_node = count.index == 0 ? "" : digitalocean_droplet.octelium[0].ipv4_address
  })

  tags = [
    "octelium",
    "ci-hub",
    var.cluster_name
  ]
}

# ============================================================================
# Cloudflare DNS
# ============================================================================

resource "cloudflare_record" "octelium" {
  count   = var.node_count
  zone_id = var.cloudflare_zone_id
  name    = split(".", var.domain)[0]  # Extract subdomain from FQDN
  type    = "A"
  value   = digitalocean_droplet.octelium[count.index].ipv4_address
  proxied = true
  ttl     = 1  # Auto TTL when proxied
}

# ============================================================================
# Outputs
# ============================================================================

output "cluster_url" {
  description = "Octelium cluster URL"
  value       = "https://${var.domain}"
}

output "node_ips" {
  description = "IP addresses of Octelium nodes"
  value       = digitalocean_droplet.octelium[*].ipv4_address
}

output "dns_records" {
  description = "Cloudflare DNS records created"
  value = [
    for record in cloudflare_record.octelium : {
      name  = record.name
      value = record.value
    }
  ]
}

output "ssh_commands" {
  description = "SSH commands to access nodes"
  value = [
    for i, droplet in digitalocean_droplet.octelium :
    "ssh root@${droplet.ipv4_address}  # ${droplet.name}"
  ]
}

output "next_steps" {
  description = "Next steps after deployment"
  value = <<-EOT
    ✅ Octelium cluster deployed successfully!

    Next steps:
    1. SSH into the first node to get the bootstrap token:
       ssh root@${digitalocean_droplet.octelium[0].ipv4_address}
       sudo cat /root/octelium-bootstrap.txt

    2. Add the bootstrap token to CI-Portal environment variables:
       OCTELIUM_CLUSTER_URL=${var.domain}
       OCTELIUM_ADMIN_TOKEN=<token-from-step-1>

    3. Test the cluster:
       curl -I https://${var.domain}/health

    4. Update CI-Hub .env:
       TUNNEL_PROVIDER=octelium
       OCTELIUM_CLUSTER_URL=https://${var.domain}
  EOT
}
