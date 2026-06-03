terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Uncomment after first apply to move state to S3.
  # backend "s3" {
  #   bucket = "chatcenter-tfstate-CHANGE_ME"
  #   key    = "prod/terraform.tfstate"
  #   region = "il-central-1"
  # }
}
