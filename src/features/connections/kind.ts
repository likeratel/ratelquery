import { Cloud, Database, ScanSearch, type LucideIcon } from "lucide-react"
import type { ConnectionConfig } from "../../lib/connections"

export const CONNECTION_KIND_ICON: Record<ConnectionConfig["kind"], LucideIcon> = {
  mysql: Database,
  dynamodb: Cloud,
  athena: ScanSearch,
}

export const CONNECTION_KIND_LABEL: Record<ConnectionConfig["kind"], string> = {
  mysql: "MySQL",
  dynamodb: "DynamoDB",
  athena: "Athena",
}
