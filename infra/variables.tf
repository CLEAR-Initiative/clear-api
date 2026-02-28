variable "railway_token" {
  description = "Railway API token"
  type        = string
  sensitive   = true
}

variable "project_name" {
  description = "Railway project name"
  type        = string
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Environment must be staging or production."
  }
}

variable "github_repo" {
  description = "GitHub repository URL"
  type        = string
}

variable "deploy_branch" {
  description = "Git branch to deploy from"
  type        = string
  default     = "main"
}

variable "cors_origin" {
  description = "Allowed CORS origin"
  type        = string
}
