# Option A: Terraform Cloud (recommended for teams)
# terraform {
#   cloud {
#     organization = "your-org"
#     workspaces {
#       name = "apollo-server"
#     }
#   }
# }

# Option B: S3-compatible backend (if self-managing state)
# terraform {
#   backend "s3" {
#     bucket = "your-terraform-state"
#     key    = "apollo-server/terraform.tfstate"
#     region = "us-east-1"
#   }
# }
