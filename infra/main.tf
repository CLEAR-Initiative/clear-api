provider "railway" {
  token = var.railway_token
}

module "api" {
  source = "./modules/railway-service"

  project_name = var.project_name
  service_name = "apollo-server"
  environment  = var.environment

  source_repo    = var.github_repo
  source_branch  = var.deploy_branch
  root_directory = "/"

  environment_variables = {
    NODE_ENV    = var.environment
    PORT        = "4000"
    CORS_ORIGIN = var.cors_origin
  }

  healthcheck_path = "/health"
}
