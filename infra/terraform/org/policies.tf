# Every project under prod (spurby-phi, spurby-data).
locals {
  prod = google_folder.this["prod"].name
}

resource "google_org_policy_policy" "prod_locations" {
  name   = "${local.prod}/policies/gcp.resourceLocations"
  parent = local.prod
  spec {
    rules {
      values {
        allowed_values = var.allowed_locations
      }
    }
  }
}

resource "google_org_policy_policy" "prod_uniform_bucket_access" {
  name   = "${local.prod}/policies/storage.uniformBucketLevelAccess"
  parent = local.prod
  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "prod_sql_no_public_ip" {
  name   = "${local.prod}/policies/sql.restrictPublicIp"
  parent = local.prod
  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

# spurby-phi only: spurby-data may serve public datasets, so these stay off there.
locals {
  phi = "projects/${data.google_project.phi.number}"
}

resource "google_org_policy_policy" "phi_cmek" {
  name   = "${local.phi}/policies/gcp.restrictNonCmekServices"
  parent = local.phi
  spec {
    rules {
      values {
        denied_values = ["storage.googleapis.com", "sqladmin.googleapis.com"]
      }
    }
  }
}

resource "google_org_policy_policy" "phi_public_access_prevention" {
  name   = "${local.phi}/policies/storage.publicAccessPrevention"
  parent = local.phi
  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

resource "google_org_policy_policy" "phi_no_vm_external_ip" {
  name   = "${local.phi}/policies/compute.vmExternalIpAccess"
  parent = local.phi
  spec {
    rules {
      deny_all = "TRUE"
    }
  }
}
