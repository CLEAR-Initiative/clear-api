variable "project_name" {
  description = "Railway project name"
  type        = string
}

variable "service_name" {
  description = "Name of the Railway service"
  type        = string
}

variable "environment" {
  description = "Deployment environment"
  type        = string
}

variable "source_repo" {
  description = "GitHub repository URL"
  type        = string
}

variable "source_branch" {
  description = "Git branch to deploy"
  type        = string
}

variable "root_directory" {
  description = "Root directory for the service"
  type        = string
  default     = "/"
}

variable "environment_variables" {
  description = "Environment variables for the service"
  type        = map(string)
  default     = {}
}

variable "healthcheck_path" {
  description = "Path for health check endpoint"
  type        = string
  default     = "/health"
}
