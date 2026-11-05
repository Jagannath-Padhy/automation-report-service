import { TestResult } from "../../types/payload";
import { fetchData } from "../../utils/redisUtils";
import logger from "@ondc/automation-logger";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { getActionData } from "../../services/actionDataService";
import { PURCHASE_FINANCE_FLOWS } from "../../utils/constants";

/**
 * Normalizes HTML content for comparison by:
 * - Removing whitespace and newlines
 * - Normalizing attribute order
 * - Removing EJS template variables
 * - Converting to lowercase for comparison
 */
function normalizeHTML(html: string): string {
  if (!html) return "";
  
  return html
    .replace(/<%=[\s\S]*?%>/g, "") // Remove EJS template variables
    .replace(/\s+/g, " ") // Replace multiple whitespace with single space
    .replace(/>\s+</g, "><") // Remove whitespace between tags
    .trim()
    .toLowerCase();
}

/**
 * Extracts form structure (fields, labels, types) from HTML for comparison
 */
function extractFormStructure(html: string): {
  fields: Array<{ name: string; type: string; required: boolean; label?: string }>;
  formId?: string;
} {
  const structure: {
    fields: Array<{ name: string; type: string; required: boolean; label?: string }>;
    formId?: string;
  } = { fields: [] };

  try {
    // Extract form ID
    const formIdMatch = html.match(/<form[^>]*id=["']([^"']+)["']/i);
    if (formIdMatch) {
      structure.formId = formIdMatch[1];
    }

    // Extract all input, select, textarea elements
    const fieldPattern = /<(input|select|textarea)[^>]*>/gi;
    const matches = html.match(fieldPattern) || [];

    matches.forEach((match) => {
      const nameMatch = match.match(/name=["']([^"']+)["']/i);
      const idMatch = match.match(/id=["']([^"']+)["']/i);
      const typeMatch = match.match(/type=["']([^"']+)["']/i);
      const tagMatch = match.match(/<(input|select|textarea)/i);
      
      const name = nameMatch?.[1] || idMatch?.[1];
      if (!name || name === "formId" || name === "submit") {
        return; // Skip hidden formId and submit buttons
      }

      const type = typeMatch?.[1]?.toLowerCase() || tagMatch?.[1]?.toLowerCase() || "text";
      const required = /required/i.test(match);

      // Try to find associated label
      let label: string | undefined;
      const id = idMatch?.[1];
      if (id) {
        const labelForPattern = new RegExp(
          `<label[^>]*for=["']${id}["'][^>]*>([^<]+)</label>`,
          "i"
        );
        const labelMatch = html.match(labelForPattern);
        if (labelMatch) {
          label = labelMatch[1].trim();
        }
      }

      // If no label found, look for preceding label
      if (!label) {
        const beforeMatch = html.substring(0, html.indexOf(match));
        const labelPattern = /<label[^>]*>([^<]+)<\/label>\s*$/i;
        const lastLabelMatch = beforeMatch.match(labelPattern);
        if (lastLabelMatch) {
          label = lastLabelMatch[1].trim();
        }
      }

      structure.fields.push({
        name,
        type,
        required,
        label: label || undefined,
      });
    });
  } catch (error: any) {
    logger.error("Error extracting form structure", error);
  }

  return structure;
}

/**
 * Compares two HTML forms by structure and content
 * Returns true if forms match, false otherwise
 */
function compareFormHTML(actualHTML: string, expectedHTML: string): {
  matches: boolean;
  differences: string[];
} {
  const differences: string[] = [];
  
  // Normalize both HTMLs
  const normalizedActual = normalizeHTML(actualHTML);
  const normalizedExpected = normalizeHTML(expectedHTML);

  // Extract form structures
  const actualStructure = extractFormStructure(actualHTML);
  const expectedStructure = extractFormStructure(expectedHTML);

  // Compare form structures
  if (actualStructure.formId !== expectedStructure.formId) {
    differences.push(
      `Form ID mismatch: expected "${expectedStructure.formId}", got "${actualStructure.formId}"`
    );
  }

  // Compare fields
  const expectedFieldsMap = new Map(
    expectedStructure.fields.map((f) => [f.name, f])
  );
  const actualFieldsMap = new Map(
    actualStructure.fields.map((f) => [f.name, f])
  );

  // Check for missing fields
  expectedFieldsMap.forEach((expectedField, name) => {
    const actualField = actualFieldsMap.get(name);
    if (!actualField) {
      differences.push(`Missing required field: "${name}" (${expectedField.type})`);
    } else {
      // Compare field properties
      if (expectedField.required && !actualField.required) {
        differences.push(`Field "${name}" should be required but is not`);
      }
      if (expectedField.type !== actualField.type) {
        differences.push(
          `Field "${name}" type mismatch: expected "${expectedField.type}", got "${actualField.type}"`
        );
      }
    }
  });

  // Check for unexpected fields (optional - just log, don't fail)
  actualFieldsMap.forEach((actualField, name) => {
    if (!expectedFieldsMap.has(name) && name !== "formId") {
      differences.push(`Unexpected field found: "${name}" (${actualField.type})`);
    }
  });

  // Compare normalized HTML (structure comparison)
  // Remove dynamic content like action URLs for comparison
  const actualForComparison = normalizedActual
    .replace(/action=["'][^"']*["']/gi, "")
    .replace(/method=["'][^"']*["']/gi, "");
  const expectedForComparison = normalizedExpected
    .replace(/action=["'][^"']*["']/gi, "")
    .replace(/method=["'][^"']*["']/gi, "");

  // If structures match but HTML is very different, note it
  if (differences.length === 0 && actualForComparison !== expectedForComparison) {
    // Calculate similarity (simple character-based)
    const maxLength = Math.max(actualForComparison.length, expectedForComparison.length);
    const minLength = Math.min(actualForComparison.length, expectedForComparison.length);
    const similarity = minLength / maxLength;
    
    if (similarity < 0.8) {
      differences.push(
        `HTML content structure differs significantly (similarity: ${(similarity * 100).toFixed(1)}%)`
      );
    }
  }

  return {
    matches: differences.length === 0,
    differences,
  };
}

/**
 * Fetches expected form HTML from form service config
 * Tries to read from form service config directory
 */
async function getExpectedFormHTML(formUrl: string, domain?: string): Promise<string | null> {
  try {
    // Extract domain and form name from URL
    // URL format: http://localhost:3300/forms/FIS12/consumer_information_form?...
    let formDomain = domain;
    let formName = formUrl;

    if (formUrl.includes("/")) {
      const urlParts = formUrl.split("/");
      const formPart = urlParts[urlParts.length - 1]?.split("?")[0];
      
      // Try to extract domain from URL
      // URL structure: http://localhost:3300/forms/FIS12/kyc_verification_status?...
      // We need to find the domain (FIS12) which is typically the second-to-last part
      for (let i = urlParts.length - 1; i >= 0; i--) {
        const part = urlParts[i];
        // Skip empty parts, query params, and protocol/host parts
        if (part && !part.includes(":") && !part.includes("?") && part !== "forms") {
          if (i > 0 && urlParts[i - 1] === "forms") {
            // This is the domain (e.g., FIS12)
            formDomain = part;
          } else if (!formName || formName === formUrl) {
            // This is likely the form name
            formName = formPart || part;
          }
        }
      }
      
      if (formPart) {
        formName = formPart;
      }
    }

    // Try multiple path resolution strategies
    const possiblePaths: string[] = [];
    
    // Get workspace root - try multiple strategies
    let workspaceRoot: string | null = null;
    
    // Strategy 1: Try to find workspace root by looking for automation-form-service directory
    const currentDir = __dirname;
    let searchDir = currentDir;
    for (let i = 0; i < 10; i++) { // Max 10 levels up
      const formServicePath = path.join(searchDir, "automation-form-service");
      if (fs.existsSync(formServicePath)) {
        workspaceRoot = searchDir;
        break;
      }
      const parent = path.dirname(searchDir);
      if (parent === searchDir) break; // Reached root
      searchDir = parent;
    }
    
    // Strategy 2: If not found, use relative path from __dirname
    if (!workspaceRoot) {
      workspaceRoot = path.resolve(__dirname, "../../../../");
    }
    
    // Strategy 3: Try absolute path from workspace root
    const absolutePath = path.join(
      workspaceRoot,
      "automation-form-service/src/config",
      formDomain || "FIS12",
      formName,
      "form.html"
    );
    possiblePaths.push(absolutePath);
    
    // Strategy 4: Try relative path from current __dirname
    const relativePath = path.join(
      __dirname,
      "../../../automation-form-service/src/config",
      formDomain || "FIS12",
      formName,
      "form.html"
    );
    possiblePaths.push(relativePath);

    // Strategy 5: Try with different form name variations (if form name has underscores)
    if (formName.includes("_")) {
      const kebabCase = formName.replace(/_/g, "-");
      possiblePaths.push(
        path.join(
          workspaceRoot,
          "automation-form-service/src/config",
          formDomain || "FIS12",
          kebabCase,
          "form.html"
        )
      );
    }
    
    // Strategy 6: Try without domain (default to FIS12)
    possiblePaths.push(
      path.join(
        workspaceRoot,
        "automation-form-service/src/config",
        "FIS12",
        formName,
        "form.html"
      )
    );

    // Try each path
    for (const formServicePath of possiblePaths) {
      if (fs.existsSync(formServicePath)) {
        const expectedHTML = fs.readFileSync(formServicePath, "utf8");
        logger.info(`Loaded expected form HTML from: ${formServicePath}`, {
          formUrl,
          domain: formDomain,
          formName,
          resolvedPath: formServicePath
        });
        return expectedHTML;
      }
    }

    // Log all attempted paths for debugging
    logger.info(`Expected form HTML not found. Attempted paths:`, {
      formUrl,
      domain: formDomain,
      formName,
      attemptedPaths: possiblePaths
    });
    
    return null;
  } catch (error: any) {
    logger.error("Error fetching expected form HTML", error, {
      formUrl,
      domain,
      errorMessage: error.message
    });
    return null;
  }
}

/**
 * Validates HTML_FORM action by:
 * 1. Fetching form URL from Redis (saved during on_search)
 * 2. Calling form service to get HTML
 * 3. Parsing HTML to extract required fields
 * 4. Comparing with expected form HTML (if available)
 * 5. Showing validation results
 */
export async function validateHTMLForm(
  sessionID: string,
  transactionId: string,
  flowId: string,
  testResults: TestResult,
  validateContent: boolean = true // Whether to validate form content (required vs optional)
): Promise<void> {
  try {
    // Step 1: Fetch form URLs from Redis
    const formUrlsData = await fetchData(sessionID, transactionId, "formUrls");
    
    if (!formUrlsData || !formUrlsData.urls || formUrlsData.urls.length === 0) {
      testResults.failed.push(
        "No form URLs found in Redis. Form URLs should be saved during on_search validation."
      );
      return;
    }

    // Mock form URLs can carry a trailing slash before the query string
    // (".../investor_details_form/?transaction_id=..."), which breaks the
    // form name/domain parsing below -- drop it.
    const formUrls: string[] = formUrlsData.urls.map((u: string) =>
      u.replace(/\/+(\?|$)/, "$1")
    );
    
    // Deduplicate form URLs by extracting form name (to avoid processing same form twice)
    const uniqueFormUrls = new Map<string, string>();
    formUrls.forEach((url) => {
      const urlParts = url.split("/");
      const formName = urlParts[urlParts.length - 1]?.split("?")[0];
      if (formName && !uniqueFormUrls.has(formName)) {
        uniqueFormUrls.set(formName, url);
      }
    });
    
    const uniqueUrls = Array.from(uniqueFormUrls.values());
    testResults.passed.push(
      `Found ${formUrls.length} form URL(s) in Redis, processing ${uniqueUrls.length} unique form(s) for validation`
    );

    // Step 2: Process each unique form URL
    for (let i = 0; i < uniqueUrls.length; i++) {
      const formUrl = uniqueUrls[i];
      
      try {
        // Extract form name from URL
        // URL format: http://localhost:3300/forms/FIS12/consumer_information_form?session_id=...
        const urlParts = formUrl.split("/");
        const formName = urlParts[urlParts.length - 1]?.split("?")[0];
        
        testResults.passed.push(
          `Processing form ${i + 1}: ${formName || formUrl}`
        );

        // Step 3: Call form service to get HTML
        const formServiceUrl = process.env.FORM_SERVICE_URL || "http://localhost:3300";
        const formResponse = await axios.get(formUrl, {
          timeout: 10000,
          validateStatus: (status) => status < 500, // Accept 4xx as valid responses
        });

        if (formResponse.status !== 200) {
          testResults.failed.push(
            `Form ${i + 1} (${formName}): Failed to fetch HTML. Status: ${formResponse.status}`
          );
          continue;
        }

        const htmlContent = formResponse.data;
        if (!htmlContent || typeof htmlContent !== "string") {
          testResults.failed.push(
            `Form ${i + 1} (${formName}): Invalid HTML content received`
          );
          continue;
        }

        testResults.passed.push(
          `Form ${i + 1} (${formName}): Successfully fetched HTML from form service`
        );

        // Step 4: Parse HTML to extract required fields and all fields
        const requiredFields = extractRequiredFields(htmlContent);
        const allFields = extractAllFields(htmlContent);
        
        // Check if form has any fields at all
        if (allFields.length === 0) {
          testResults.failed.push(
            `Form ${i + 1} (${formName}): No form fields found in HTML form`
          );
        } else if (requiredFields.length === 0) {
          // Form has fields but none are required - this is valid for forms with all optional fields
          testResults.passed.push(
            `Form ${i + 1} (${formName}): Found ${allFields.length} field(s), all are optional (no required fields)`
          );
        } else {
          testResults.passed.push(
            `Form ${i + 1} (${formName}): Found ${requiredFields.length} required field(s) out of ${allFields.length} total field(s)`
          );
          
          // Add details about required fields
          requiredFields.forEach((field) => {
            testResults.passed.push(
              `Form ${i + 1} - Required Field: "${field.label || field.name}" (${field.type})`
            );
          });
        }

        // Step 5: Validate form content against expected HTML
        // Extract domain from URL if available
        const urlPartsForDomain = formUrl.split("/");
        let domain: string | undefined;
        if (urlPartsForDomain.length >= 2) {
          const possibleDomain = urlPartsForDomain[urlPartsForDomain.length - 2];
          if (possibleDomain && !possibleDomain.includes(":") && !possibleDomain.includes(".")) {
            domain = possibleDomain;
          }
        }

        const expectedHTML = await getExpectedFormHTML(formUrl, domain);
        
        if (expectedHTML) {
          testResults.passed.push(
            `Form ${i + 1} (${formName}): Expected form HTML template found`
          );

          const comparison = compareFormHTML(htmlContent, expectedHTML);
          
          if (comparison.matches) {
            testResults.passed.push(
              `Form ${i + 1} (${formName}): Form content matches expected template`
            );
          } else {
            // Content doesn't match
            if (validateContent) {
              // Required validation - raise error
              const errorMessage = `Form ${i + 1} (${formName}): Form content does not match expected template (REQUIRED)`;
              testResults.failed.push(errorMessage);
              
              // Add detailed differences
              comparison.differences.forEach((diff) => {
                testResults.failed.push(`  - ${diff}`);
              });
            } else {
              // Optional validation - just pass
              testResults.passed.push(
                `Form ${i + 1} (${formName}): Form content does not match expected template (OPTIONAL - passed)`
              );
              
              // Log differences for information (but don't fail)
              comparison.differences.forEach((diff) => {
                testResults.passed.push(`  - Note: ${diff}`);
              });
            }
          }
        } else {
          return
        }

      } catch (error: any) {
        logger.error(`Error processing form URL ${formUrl}`, error);
        testResults.failed.push(
          `Form ${i + 1}: Error processing form - ${error.message}`
        );
      }
    }

  } catch (error: any) {
    logger.error("Error in HTML_FORM validation", error);
    testResults.failed.push(
      `HTML_FORM validation failed: ${error.message}`
    );
  }
}

/**
 * Extracts all form fields (input, select, textarea) from HTML
 */
function extractAllFields(html: string): Array<{
  name: string;
  type: string;
  label?: string;
}> {
  const allFields: Array<{ name: string; type: string; label?: string }> = [];
  
  try {
    // Regex pattern to find all form elements
    const fieldPattern = /<(input|select|textarea)[^>]*>/gi;
    const matches = html.match(fieldPattern) || [];
    
    matches.forEach((match) => {
      // Skip hidden formId and submit buttons
      const nameMatch = match.match(/name=["']([^"']+)["']/i);
      const idMatch = match.match(/id=["']([^"']+)["']/i);
      const typeMatch = match.match(/type=["']([^"']+)["']/i);
      const tagMatch = match.match(/<(input|select|textarea)/i);
      
      const name = nameMatch?.[1] || idMatch?.[1];
      if (!name || name === "formId" || typeMatch?.[1]?.toLowerCase() === "submit" || typeMatch?.[1]?.toLowerCase() === "button") {
        return; // Skip hidden formId and submit buttons
      }

      const type = typeMatch?.[1]?.toLowerCase() || tagMatch?.[1]?.toLowerCase() || "text";
      
      // Try to find associated label
      let label: string | undefined;
      const id = idMatch?.[1];
      if (id) {
        const labelForPattern = new RegExp(
          `<label[^>]*for=["']${id}["'][^>]*>([^<]+)</label>`,
          "i"
        );
        const labelMatch = html.match(labelForPattern);
        if (labelMatch) {
          label = labelMatch[1].trim();
        }
      }
      
      // If no label found, look for preceding label
      if (!label) {
        const beforeMatch = html.substring(0, html.indexOf(match));
        const labelPattern = /<label[^>]*>([^<]+)<\/label>\s*$/i;
        const lastLabelMatch = beforeMatch.match(labelPattern);
        if (lastLabelMatch) {
          label = lastLabelMatch[1].trim();
        }
      }

      // Avoid duplicates
      if (!allFields.find((f) => f.name === name)) {
        allFields.push({
          name,
          type,
          label: label || undefined,
        });
      }
    });
  } catch (error: any) {
    logger.error("Error parsing HTML for all fields", error);
  }

  return allFields;
}

/**
 * Extracts required fields from HTML form using regex
 * Looks for input, select, textarea elements with required attribute
 */
function extractRequiredFields(html: string): Array<{
  name: string;
  type: string;
  label?: string;
}> {
  const requiredFields: Array<{ name: string; type: string; label?: string }> = [];
  
  try {
    // Regex patterns to find form elements with required attribute
    // Exclude fields marked as "optional"
    const requiredInputPattern = /<(input|select|textarea)[^>]*>/gi;
    const matches = html.match(requiredInputPattern) || [];
    
    matches.forEach((match) => {
      // Skip fields marked as optional
      if (/optional/i.test(match)) {
        return;
      }
      
      // Only include fields with required attribute (or data-required="true")
      if (!/required/i.test(match) && !/data-required=["']true["']/i.test(match)) {
        return;
      }
      
      // Extract name attribute
      const nameMatch = match.match(/name=["']([^"']+)["']/i);
      const idMatch = match.match(/id=["']([^"']+)["']/i);
      const name = nameMatch?.[1] || idMatch?.[1];
      
      // Skip hidden formId and submit buttons
      if (!name || name === "formId" || /type=["'](submit|button)["']/i.test(match)) {
        return;
      }
      
      // Extract type attribute
      const typeMatch = match.match(/type=["']([^"']+)["']/i);
      const tagMatch = match.match(/<(input|select|textarea)/i);
      const type = typeMatch?.[1] || tagMatch?.[1]?.toLowerCase() || "text";
      
      // Try to find associated label
      let label: string | undefined;
      const id = idMatch?.[1];
      if (id) {
        // Look for label with 'for' attribute
        const labelForPattern = new RegExp(
          `<label[^>]*for=["']${id}["'][^>]*>([^<]+)</label>`,
          "i"
        );
        const labelMatch = html.match(labelForPattern);
        if (labelMatch) {
          label = labelMatch[1].trim();
        }
      }
      
      // If no label found, look for preceding label
      if (!label) {
        const beforeMatch = html.substring(0, html.indexOf(match));
        const labelPattern = /<label[^>]*>([^<]+)<\/label>\s*$/i;
        const lastLabelMatch = beforeMatch.match(labelPattern);
        if (lastLabelMatch) {
          label = lastLabelMatch[1].trim();
        }
      }

      // Avoid duplicates
      if (!requiredFields.find((f) => f.name === name)) {
        requiredFields.push({
          name,
          type,
          label: label || undefined,
        });
      }
    });

    // Also check for fields marked as required via data attributes
    const dataRequiredPattern = /<(input|select|textarea)[^>]*data-required=["']true["'][^>]*>/gi;
    const dataRequiredMatches = html.match(dataRequiredPattern) || [];
    
    dataRequiredMatches.forEach((match) => {
      const nameMatch = match.match(/name=["']([^"']+)["']/i);
      const idMatch = match.match(/id=["']([^"']+)["']/i);
      const name = nameMatch?.[1] || idMatch?.[1];
      
      if (name && !requiredFields.find((f) => f.name === name)) {
        const typeMatch = match.match(/type=["']([^"']+)["']/i);
        const tagMatch = match.match(/<(input|select|textarea)/i);
        const type = typeMatch?.[1] || tagMatch?.[1]?.toLowerCase() || "text";
        
        requiredFields.push({
          name,
          type,
        });
      }
    });

  } catch (error: any) {
    logger.error("Error parsing HTML for required fields", error);
  }

  return requiredFields;
}

/**
 * Gets the previous action that has form IDs for a given flow
 * Checks possible previous actions in order of likelihood
 * @param sessionID - Session ID
 * @param flowId - Flow ID
 * @param transactionId - Transaction ID
 * @param currentAction - Current action name (e.g., "select", "init", "on_select", "on_init")
 * @returns Previous action name that has form IDs, or null if not found
 */
async function getPreviousActionWithFormIds(
  sessionID: string,
  flowId: string,
  transactionId: string,
  currentAction: string
): Promise<string | null> {
  try {
    const currentActionLower = currentAction.toLowerCase();
    
    // Define possible previous actions based on current action
    // Check in order: most recent/likely first
    let possiblePreviousActions: string[] = [];
    
    if (currentActionLower === "search") {
      // For search: previous should be on_search
      possiblePreviousActions = ["on_search"];
    } else if (currentActionLower === "on_search") {
      // For on_search: previous should be search
      possiblePreviousActions = ["search"];
    } else if (currentActionLower === "select") {
      // For select: previous could be on_select (from previous select) or on_search
      possiblePreviousActions = ["on_select", "on_search"];
    } else if (currentActionLower === "on_select") {
      // For on_select: previous should be select
      possiblePreviousActions = ["select"];
    } else if (currentActionLower === "init") {
      // For init: previous could be on_init (from previous init) or on_status
      // Check on_init first (more recent), then on_status as fallback
      // init_2 should validate against on_init_1, init_3 should validate against on_status
      possiblePreviousActions = ["on_init", "on_status"];
    } else if (currentActionLower === "on_init") {
      // For on_init: previous should be init
      possiblePreviousActions = ["init"];
    } else if (currentActionLower === "on_status") {
      // For on_status: previous could be on_init or on_select
      // Check in order: most recent first
      possiblePreviousActions = ["on_init", "on_select"];
    } else {
      return null;
    }
    
    // Check each possible previous action to see if it has form IDs
    for (const prevAction of possiblePreviousActions) {
      const prevActionData = await getActionData(sessionID, flowId, transactionId, prevAction);
      
      // If data exists, check for form IDs
      if (prevActionData) {
        const formIds = getFormIdsFromActionData(prevActionData, prevAction);
        // Return if we found form IDs
        // For on_search: returns all form IDs (even without form_response) as it's the source
        // For other actions: returns only form IDs with form_response
        if (formIds.length > 0) {
          return prevAction; // Found previous action with form IDs
        }
        // For on_search, on_select, on_init, on_status, or search, even if no form IDs extracted but data exists, return it
        // (data might be in a format we haven't handled yet, but it exists)
        // This is important because:
        // - on_search_3 might have form_response and need to validate against search_3
        // - select_3 should validate against on_select_2/on_select (previous on_select)
        // - init_2 should validate against on_init_1/on_init (previous on_init)
        // - init_3 should validate against on_status (previous on_status)
        const prevActionLower = prevAction.toLowerCase();
        if (prevActionLower === "on_search" || prevActionLower === "on_select" || prevActionLower === "on_init" || prevActionLower === "on_status" || prevActionLower === "search") {
          return prevAction;
        }
      }
    }
    
    return null; // No previous action with form IDs found
  } catch (error) {
    logger.error("Error getting previous action with form IDs", error);
    return null;
  }
}

/**
 * Gets form IDs from a previous action's data
 * For on_search: returns all form IDs (even without form_response) as it's the source of truth
 * For other actions: only returns form IDs with form_response
 * @param previousActionData - Data from previous action
 * @param actionName - Name of the previous action (to determine if it's on_search)
 * @returns Array of form IDs
 */
function getFormIdsFromActionData(previousActionData: any, actionName?: string): string[] {
  const formIds: string[] = [];
  
  if (!previousActionData) {
    return formIds;
  }
  
  const isOnSearch = actionName?.toLowerCase() === "on_search";
  const isOnSelect = actionName?.toLowerCase() === "on_select";
  const isOnInit = actionName?.toLowerCase() === "on_init";
  const isOnStatus = actionName?.toLowerCase() === "on_status";
  const isSearch = actionName?.toLowerCase() === "search";
  
  // Handle on_search, on_select, on_init, on_status, and search extracted format: form_ids[] array (from save spec)
  // on_search save spec: form_ids: "$.message.catalog.providers[*].items[*].xinput.form.id"
  // on_select save spec: form_ids: "$.message.order.items[*].xinput.form.id"
  // on_init save spec: form_ids: "$.message.order.items[*].xinput.form.id"
  // search save spec: form_ids: "$.message.intent.provider.items[*].xinput.form.id"
  // This should extract ALL form IDs from ALL providers/items
  if ((isOnSearch || isOnSelect || isOnInit || isOnStatus || isSearch) && previousActionData.form_ids !== undefined && previousActionData.form_ids !== null) {
    if (Array.isArray(previousActionData.form_ids)) {
      // Array of form IDs - extract all
      for (const formId of previousActionData.form_ids) {
        if (formId !== null && formId !== undefined && formId !== '') {
          const formIdStr = String(formId).trim();
          if (formIdStr && !formIds.includes(formIdStr)) {
            formIds.push(formIdStr);
          }
        }
      }
    } else if (typeof previousActionData.form_ids === 'string') {
      // Single form ID as string
      const formIdStr = previousActionData.form_ids.trim();
      if (formIdStr && !formIds.includes(formIdStr)) {
        formIds.push(formIdStr);
      }
    } else if (typeof previousActionData.form_ids === 'object') {
      // Might be an object with form IDs - try to extract
      logger.info(`Debug: form_ids is an object, not array or string`, {
        formIdsType: typeof previousActionData.form_ids,
        formIdsValue: previousActionData.form_ids
      });
    }
  }
  
  // Handle on_search extracted format: items[] array (from save spec)
  // Save spec extracts: items: "$.message.catalog.providers[*].items[*]"
  if (isOnSearch && previousActionData.items) {
    if (Array.isArray(previousActionData.items)) {
      for (const item of previousActionData.items) {
        if (item?.xinput?.form?.id) {
          // For on_search, include all form IDs (even without form_response)
          const formId = item.xinput.form.id;
          if (formId && !formIds.includes(formId)) {
            formIds.push(formId);
          }
        }
      }
    } else if (previousActionData.items?.xinput?.form?.id) {
      // Single item object
      const formId = previousActionData.items.xinput.form.id;
      if (formId && !formIds.includes(formId)) {
        formIds.push(formId);
      }
    }
  }
  
  // Handle on_search extracted format: providers[] array (from save spec)
  // Save spec extracts: providers: "$.message.catalog.providers[*]"
  if (isOnSearch && previousActionData.providers) {
    if (Array.isArray(previousActionData.providers)) {
      for (const provider of previousActionData.providers) {
        if (provider.items && Array.isArray(provider.items)) {
          for (const item of provider.items) {
            if (item?.xinput?.form?.id) {
              // For on_search, include all form IDs (even without form_response)
              const formId = item.xinput.form.id;
              if (formId && !formIds.includes(formId)) {
                formIds.push(formId);
              }
            }
          }
        } else if (provider.items?.xinput?.form?.id) {
          // Single item in provider
          const formId = provider.items.xinput.form.id;
          if (formId && !formIds.includes(formId)) {
            formIds.push(formId);
          }
        }
      }
    } else if (previousActionData.providers?.items) {
      // Single provider object
      const provider = previousActionData.providers;
      if (Array.isArray(provider.items)) {
        for (const item of provider.items) {
          if (item?.xinput?.form?.id) {
            const formId = item.xinput.form.id;
            if (formId && !formIds.includes(formId)) {
              formIds.push(formId);
            }
          }
        }
      } else if (provider.items?.xinput?.form?.id) {
        const formId = provider.items.xinput.form.id;
        if (formId && !formIds.includes(formId)) {
          formIds.push(formId);
        }
      }
    }
  }
  
  // Handle on_search format: message.catalog.providers[].items[].xinput.form.id (when data is saved as full message)
  if (previousActionData.message?.catalog?.providers && Array.isArray(previousActionData.message.catalog.providers)) {
    for (const provider of previousActionData.message.catalog.providers) {
      if (provider.items && Array.isArray(provider.items)) {
        for (const item of provider.items) {
          if (item?.xinput?.form?.id) {
            // For on_search, include all form IDs; for others, only with form_response
            if (isOnSearch || item?.xinput?.form_response) {
              const formId = item.xinput.form.id;
              if (!formIds.includes(formId)) {
                formIds.push(formId);
              }
            }
          }
        }
      }
    }
  }
  
  // Handle on_search format: catalog.providers[].items[].xinput.form.id (when data is extracted but has catalog)
  if (previousActionData.catalog?.providers && Array.isArray(previousActionData.catalog.providers)) {
    for (const provider of previousActionData.catalog.providers) {
      if (provider.items && Array.isArray(provider.items)) {
        for (const item of provider.items) {
          if (item?.xinput?.form?.id) {
            // For on_search, include all form IDs; for others, only with form_response
            if (isOnSearch || item?.xinput?.form_response) {
              const formId = item.xinput.form.id;
              if (!formIds.includes(formId)) {
                formIds.push(formId);
              }
            }
          }
        }
      }
    }
  }
  
  // Handle on_search format (fallback): message.providers[].items[].xinput.form.id
  if (previousActionData.message?.providers && Array.isArray(previousActionData.message.providers)) {
    for (const provider of previousActionData.message.providers) {
      if (provider.items && Array.isArray(provider.items)) {
        for (const item of provider.items) {
          if (item?.xinput?.form?.id) {
            // For on_search, include all form IDs; for others, only with form_response
            if (isOnSearch || item?.xinput?.form_response) {
              const formId = item.xinput.form.id;
              if (!formIds.includes(formId)) {
                formIds.push(formId);
              }
            }
          }
        }
      }
    }
  }
  
  // Handle select/init/on_select/on_init/on_status format: order.items[].xinput.form.id
  // For on_select, on_init, and on_status: include all form IDs (even without form_response) as they're sources for select/init
  // For other actions: only include if form_response exists (form was already submitted)
  if (previousActionData.order?.items && Array.isArray(previousActionData.order.items)) {
    for (const item of previousActionData.order.items) {
      if (item?.xinput?.form?.id) {
        // For on_select, on_init, and on_status, include all form IDs; for others, only with form_response
        if (isOnSelect || isOnInit || isOnStatus || item?.xinput?.form_response) {
          const formId = item.xinput.form.id;
          if (!formIds.includes(formId)) {
            formIds.push(formId);
          }
        }
      }
    }
  }
  
  // Handle items array directly (from save spec)
  // Note: For search, items might be just IDs (strings), not full objects with xinput
  // For on_select, on_init, and on_status: include all form IDs (even without form_response) as they're sources for select/init
  // For other actions: only include if form_response exists (form was already submitted)
  if (previousActionData.items && Array.isArray(previousActionData.items)) {
    for (const item of previousActionData.items) {
      // Check if item is an object with xinput (not just a string ID)
      // For search, items array contains just IDs, so skip this check
      if (typeof item === 'object' && item !== null && item?.xinput?.form?.id) {
        // For on_select, on_init, and on_status, include all form IDs; for others, only with form_response
        if (isOnSelect || isOnInit || isOnStatus || item?.xinput?.form_response) {
          const formId = item.xinput.form.id;
          if (!formIds.includes(formId)) {
            formIds.push(formId);
          }
        }
      }
    }
  }
  
  // Handle search format: intent.provider.items[].xinput.form.id
  // isSearch is already declared above
  
  // First check if we have the full message structure (message.intent.provider.items)
  // This is the most reliable source for search form IDs
  if (previousActionData.message?.intent?.provider?.items) {
    if (Array.isArray(previousActionData.message.intent.provider.items)) {
      for (const item of previousActionData.message.intent.provider.items) {
        if (item?.xinput?.form?.id) {
          // For search, include all form IDs (even without form_response) as it's the source
          if (isSearch) {
            const formId = item.xinput.form.id;
            if (!formIds.includes(formId)) {
              formIds.push(formId);
            }
          } else if (item?.xinput?.form_response) {
            // For other actions, only include if it has form_response
            const formId = item.xinput.form.id;
            if (!formIds.includes(formId)) {
              formIds.push(formId);
            }
          }
        }
      }
    } else if (previousActionData.message.intent.provider.items?.xinput?.form?.id) {
      // Single item
      const formId = previousActionData.message.intent.provider.items.xinput.form.id;
      if (isSearch || previousActionData.message.intent.provider.items?.xinput?.form_response) {
        if (!formIds.includes(formId)) {
          formIds.push(formId);
        }
      }
    }
  }
  
  // Handle search format: intent.provider.items[].xinput.form.id (when data is extracted but has intent)
  if (previousActionData.intent?.provider?.items) {
    if (Array.isArray(previousActionData.intent.provider.items)) {
      for (const item of previousActionData.intent.provider.items) {
        if (item?.xinput?.form?.id) {
          // For search, include all form IDs (even without form_response) as it's the source
          // For other actions, only include if it has form_response
          if (isSearch) {
            const formId = item.xinput.form.id;
            if (!formIds.includes(formId)) {
              formIds.push(formId);
            }
          } else if (item?.xinput?.form_response) {
            const formId = item.xinput.form.id;
            if (!formIds.includes(formId)) {
              formIds.push(formId);
            }
          }
        }
      }
    } else if (previousActionData.intent.provider.items?.xinput?.form?.id) {
      // Single item
      const formId = previousActionData.intent.provider.items.xinput.form.id;
      if (isSearch || previousActionData.intent.provider.items?.xinput?.form_response) {
        if (!formIds.includes(formId)) {
          formIds.push(formId);
        }
      }
    }
  }
  
  // Handle search format: message.intent.item (when item is a single object, not array)
  // Note: search save spec extracts items as IDs array, but full message might have item object
  if (previousActionData.message?.intent?.item) {
    const item = previousActionData.message.intent.item;
    if (item?.xinput?.form?.id) {
      if (isSearch || item?.xinput?.form_response) {
        const formId = item.xinput.form.id;
        if (!formIds.includes(formId)) {
          formIds.push(formId);
        }
      }
    }
  }
  
  // Handle search format: intent.item (when item is extracted as single object)
  if (previousActionData.intent?.item) {
    const item = previousActionData.intent.item;
    if (item?.xinput?.form?.id) {
      if (isSearch || item?.xinput?.form_response) {
        const formId = item.xinput.form.id;
        if (!formIds.includes(formId)) {
          formIds.push(formId);
        }
      }
    }
  }
  
  // Handle search extracted format: provider_items[] array (from save spec)
  // search save spec: provider_items: "$.message.intent.provider.items[*]"
  if (isSearch && previousActionData.provider_items) {
    if (Array.isArray(previousActionData.provider_items)) {
      for (const item of previousActionData.provider_items) {
        if (item?.xinput?.form?.id) {
          // For search, include all form IDs (even without form_response) as it's the source
          const formId = item.xinput.form.id;
          if (!formIds.includes(formId)) {
            formIds.push(formId);
          }
        }
      }
    } else if (previousActionData.provider_items?.xinput?.form?.id) {
      // Single item
      const formId = previousActionData.provider_items.xinput.form.id;
      if (!formIds.includes(formId)) {
        formIds.push(formId);
      }
    }
  }
  
  // Debug: Log if on_search but no form IDs found, or if form IDs found but might be incomplete
  if (isOnSearch) {
    if (formIds.length === 0) {
      logger.info(`Debug: No form IDs extracted from on_search data`, {
        dataKeys: Object.keys(previousActionData),
        hasFormIds: !!previousActionData.form_ids,
        formIdsValue: previousActionData.form_ids,
        formIdsType: previousActionData.form_ids ? typeof previousActionData.form_ids : 'none',
        hasItems: !!previousActionData.items,
        itemsType: previousActionData.items ? typeof previousActionData.items : 'none',
        itemsIsArray: Array.isArray(previousActionData.items),
        itemsLength: previousActionData.items?.length,
        hasProviders: !!previousActionData.providers,
        providersType: previousActionData.providers ? typeof previousActionData.providers : 'none',
        providersIsArray: Array.isArray(previousActionData.providers),
        providersLength: previousActionData.providers?.length,
        sampleItem: previousActionData.items?.[0],
        sampleProvider: previousActionData.providers?.[0],
        hasCatalog: !!previousActionData.catalog,
        hasMessage: !!previousActionData.message
      });
    } else {
      // Log extracted form IDs for debugging
      logger.info(`Debug: Extracted form IDs from on_search`, {
        formIdsCount: formIds.length,
        formIds: formIds
      });
    }
  }
  
  return formIds;
}

/**
 * Common function to validate form ID consistency against previous action
 * Only validates when both previous and current actions have form_response
 * @param items - Array of items from current action
 * @param sessionID - Session ID
 * @param flowId - Flow ID
 * @param transactionId - Transaction ID
 * @param currentAction - Current action name (e.g., "select", "init", "on_select", "on_init")
 * @param testResults - TestResult object to add validation results
 */
export async function validateFormIdConsistency(
  items: any[],
  sessionID: string,
  flowId: string,
  transactionId: string,
  currentAction: string,
  testResults: { passed: string[]; failed: string[] }
): Promise<void> {
  // Check if current action has any item with form_response
  const hasFormResponseInCurrent = items.some((item: any) => item?.xinput?.form_response);
  
  // Only validate if current action has form_response (meaning form was submitted in previous call)
  if (hasFormResponseInCurrent) {
    // Get current form IDs that need to be validated
    const currentFormIds = items
      .filter((item: any) => item?.xinput?.form?.id && item?.xinput?.form_response)
      .map((item: any) => item.xinput.form.id);
    
    if (currentFormIds.length === 0) {
      return; // No form IDs to validate
    }
    
    // Get possible previous actions based on current action
    const currentActionLower = currentAction.toLowerCase();
    let possiblePreviousActions: string[] = [];
    
    if (currentActionLower === "search") {
      possiblePreviousActions = ["on_search"];
    } else if (currentActionLower === "on_search") {
      possiblePreviousActions = ["search"];
    } else if (currentActionLower === "select") {
      possiblePreviousActions = ["on_select", "on_search"];
    } else if (currentActionLower === "on_select") {
      possiblePreviousActions = ["select"];
    } else if (currentActionLower === "init") {
      // For init: previous could be on_status (for init_3), on_init (for init_2), or on_select (fallback)
      // Check all three to find matching form IDs
      possiblePreviousActions = ["on_status", "on_init", "on_select"];
    } else if (currentActionLower === "on_init") {
      possiblePreviousActions = ["init"];
    } else if (currentActionLower === "on_status") {
      possiblePreviousActions = ["on_init", "on_select"];
    } else {
      return; // Unknown action
    }
    
    // Find the previous action that has the matching form ID
    // For numbered actions (like init_2), we need to check numbered previous actions (like on_init_1)
    let matchedPreviousAction: string | null = null;
    let matchedFormIds: string[] = [];
    
    for (const prevAction of possiblePreviousActions) {
      // Check base action name only (Redis saves with base name, not numbered versions)
      const prevActionData = await getActionData(sessionID, flowId, transactionId, prevAction);
      
      if (prevActionData) {
        const prevFormIds = getFormIdsFromActionData(prevActionData, prevAction);
        
        // Check if any of the current form IDs exist in this previous action
        const matchingFormIds = currentFormIds.filter(formId => prevFormIds.includes(formId));
        
        if (matchingFormIds.length > 0) {
          // Found matching form IDs in this previous action
          matchedPreviousAction = prevAction;
          matchedFormIds = prevFormIds;
          logger.info(`Found matching form IDs in ${prevAction} for ${currentAction}`, {
            currentFormIds,
            matchingFormIds,
            prevFormIds,
            prevAction
          });
          break; // Use the first action that has matching form IDs
        }
      }
    }
    
    // If no matching previous action found, try to find any previous action with form IDs (fallback)
    if (!matchedPreviousAction) {
      const previousAction = await getPreviousActionWithFormIds(sessionID, flowId, transactionId, currentAction);
      if (previousAction) {
        const previousActionData = await getActionData(sessionID, flowId, transactionId, previousAction);
        if (previousActionData) {
          const prevFormIds = getFormIdsFromActionData(previousActionData, previousAction);
          if (prevFormIds.length > 0) {
            matchedPreviousAction = previousAction;
            matchedFormIds = prevFormIds;
          }
        }
      }
    }
    
    if (matchedPreviousAction) {
      // Validate form IDs match previous action
      for (const item of items) {
        if (item?.xinput?.form?.id && item?.xinput?.form_response) {
          const formId = item.xinput.form.id;
          if (matchedFormIds.includes(formId)) {
            testResults.passed.push(`Item ${item.id}: Form ID "${formId}" matches ${matchedPreviousAction} (form_response present)`);
          } else if (matchedFormIds.length > 0) {
            testResults.failed.push(`Item ${item.id}: Form ID "${formId}" not found in ${matchedPreviousAction}. Available form IDs: ${matchedFormIds.join(", ")}`);
          } else {
            const previousActionData = await getActionData(sessionID, flowId, transactionId, matchedPreviousAction);
            const dataKeys = previousActionData ? Object.keys(previousActionData) : [];
            testResults.failed.push(`Item ${item.id}: Form ID "${formId}" not found in ${matchedPreviousAction} (no form IDs extracted from data). Data keys: ${dataKeys.join(", ")}`);
          }
        }
        
        // Validate form_response status
        if (item?.xinput?.form_response?.status) {
          const status = item.xinput.form_response.status;
          const allowedStatuses = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "SUCCESS"];
          if (allowedStatuses.includes(status)) {
            testResults.passed.push(`Item ${item.id}: Form response status "${status}" is valid`);
          } else {
            testResults.failed.push(`Item ${item.id}: Invalid form response status "${status}". Allowed: ${allowedStatuses.join(", ")}`);
          }
        }
      }
    } else {
      // Current has form_response but no previous action found with matching form IDs
      // Check all possible previous actions and show which ones were checked
      const checkedActions: string[] = [];
      for (const prevAction of possiblePreviousActions) {
        const prevActionData = await getActionData(sessionID, flowId, transactionId, prevAction);
        if (prevActionData) {
          const prevFormIds = getFormIdsFromActionData(prevActionData, prevAction);
          checkedActions.push(`${prevAction} (available form IDs: ${prevFormIds.length > 0 ? prevFormIds.join(", ") : "none"})`);
        } else {
          checkedActions.push(`${prevAction} (no data found)`);
        }
      }
    }
  } else {
    // Current action doesn't have form_response, so it's a new form - skip validation
    for (const item of items) {
      if (item?.xinput?.form?.id) {
        testResults.passed.push(`Item ${item.id}: Form ID "${item.xinput.form.id}" is a new form (no form_response in current action)`);
      }
    }
  }
}

/**
 * Helper function to check if payload has xinput and validate form ID consistency
 * Can be called from any validation function
 * @param message - Message object from payload
 * @param sessionID - Session ID
 * @param flowId - Flow ID
 * @param transactionId - Transaction ID
 * @param currentAction - Current action name
 * @param testResults - TestResult object to add validation results
 * @param flowIds - Array of flow IDs where this validation should apply (optional, defaults to purchase finance flows)
 */
export async function validateFormIdIfXinputPresent(
  message: any,
  sessionID: string,
  flowId: string,
  transactionId: string,
  currentAction: string,
  testResults: { passed: string[]; failed: string[] },
  flowIds?: string[]
): Promise<void> {
  // Check if this flow requires form validation
  const flowsToValidate = flowIds || PURCHASE_FINANCE_FLOWS;
  
  if (!flowId || !flowsToValidate.includes(flowId)) {
    return; // Skip if not a purchase finance flow
  }

  // Extract items from message (handle different formats)
  let items: any[] = [];
  
  // Handle on_search format: catalog.providers[].items[]
  if (message?.catalog?.providers && Array.isArray(message.catalog.providers)) {
    for (const provider of message.catalog.providers) {
      if (provider.items && Array.isArray(provider.items)) {
        items.push(...provider.items);
      }
    }
  }
  // Handle search format: intent.provider.items[]
  else if (message?.intent?.provider?.items && Array.isArray(message.intent.provider.items)) {
    items = message.intent.provider.items;
  }
  // Handle order.items[] format (select, init, confirm, etc.)
  else if (message?.order?.items && Array.isArray(message.order.items)) {
    items = message.order.items;
  }
  // Handle items array directly
  else if (message?.items && Array.isArray(message.items)) {
    items = message.items;
  }
  // Handle providers array directly (fallback)
  else if (message?.providers && Array.isArray(message.providers)) {
    for (const provider of message.providers) {
      if (provider.items && Array.isArray(provider.items)) {
        items.push(...provider.items);
      }
    }
  }

  // Check if any item has xinput
  const hasXinput = items.some((item: any) => item?.xinput);
  
  if (hasXinput) {
    await validateFormIdConsistency(items, sessionID, flowId, transactionId, currentAction, testResults);
  }
}

