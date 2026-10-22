import * as yaml from "js-yaml";
import * as fs from "fs";
import * as path from "path";
import logger from "@ondc/automation-logger";
import { resolveUsecaseKey } from "./payloadUtils";

// Load ReportingConfig.yaml
export const loadConfig = (domain: string, version: string, usecaseId?: string) => {
  logger.info("Entering loadConfig function. Loading ReportingConfig.yaml...",
    {meta: { domain, version, usecaseId }},
  );
  try {
    const configPath = path.join(__dirname, "../config/ReportingConfig.yaml");
    const file = fs.readFileSync(configPath, "utf8");
    const yamlFile: any = yaml.load(file);

    const versionConfig = yamlFile?.domains?.[domain]?.versions?.[version];

    // First try with usecaseId if provided (for domains that have usecase-specific configs).
    // Session usecaseIds can arrive as slugs ("transit-insurance") or in a different case
    // than the YAML keys ("TRANSIT INSURANCE"), so resolve case/format-insensitively.
    const resolvedUsecaseId = usecaseId
      ? resolveUsecaseKey(versionConfig?.usecases, usecaseId)
      : undefined;
    let domainConfig = resolvedUsecaseId ? versionConfig?.usecases?.[resolvedUsecaseId] : null;

    // If no usecase config found, use the version config directly (for TRV10, TRV11, etc.)
    if (!domainConfig && versionConfig) {
      if (usecaseId && versionConfig?.usecases) {
        logger.error(
          `No usecase config matched '${usecaseId}' for domain '${domain}' version '${version}'; falling back to version config, which lacks per-usecase flows/validationModules.`,
          { domain, version, usecaseId, availableUsecases: Object.keys(versionConfig.usecases) }
        );
      }
      domainConfig = versionConfig;
    }
    
    if (!domainConfig) {
      logger.error(`Configuration for domain '${domain}' and version '${version}' not found.`, { domain, version, usecaseId});
      return;
    }
    
    return domainConfig;
  } catch (error) {
    logger.error("Error loading ReportingConfig.yaml", error, { domain, version });
    return null;
  }
};
