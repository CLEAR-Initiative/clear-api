resource "railway_project" "this" {
  name = var.project_name
}

resource "railway_service" "this" {
  project_id = railway_project.this.id
  name       = var.service_name

  source_repo   = var.source_repo
  root_directory = var.root_directory
}

resource "railway_variable" "env_vars" {
  for_each = var.environment_variables

  environment_id = railway_project.this.default_environment.id
  service_id     = railway_service.this.id
  name           = each.key
  value          = each.value
}
