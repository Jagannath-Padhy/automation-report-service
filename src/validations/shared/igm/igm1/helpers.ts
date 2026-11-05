import { TestResult } from "../../../../types/payload";
import {
  VALID_IGM1_COMPLAINANT_ACTIONS,
  VALID_IGM1_RESPONDENT_ACTIONS,
  VALID_IGM1_SOURCE_TYPES,
  VALID_IGM1_RESOLUTION_ACTIONS,
  VALID_IGM1_RESPONDENT_TYPES,
  VALID_IGM1_GRO_TYPES
} from "../constants";

/**
 * Validates complainant_info object
 */
export function validateIgm1ComplainantInfo(info: any, testResults: TestResult): void {
  if (!info) {
    testResults.failed.push("issue.complainant_info is missing");
    return;
  }

  if (!info.person?.name) {
    testResults.failed.push("complainant_info.person.name is missing");
  } else {
    testResults.passed.push(`Complainant name: ${info.person.name}`);
  }

  if (!info.contact?.phone) {
    testResults.failed.push("complainant_info.contact.phone is missing");
  } else {
    testResults.passed.push(`Complainant phone: ${info.contact.phone}`);
  }
}

/**
 * Validates order_details object
 */
export function validateIgm1OrderDetails(orderDetails: any, category: string, testResults: TestResult): void {
  if (!orderDetails) {
    testResults.failed.push("issue.order_details is missing");
    return;
  }

  if (!orderDetails.id) {
    testResults.failed.push("order_details.id is missing");
  } else {
    testResults.passed.push(`Order ID: ${orderDetails.id}`);
  }

  if (!orderDetails.state) {
    testResults.failed.push("order_details.state is missing");
  } else {
    testResults.passed.push(`Order state: ${orderDetails.state}`);
  }

  // Validate items for ITEM category
  if (category === "ITEM") {
    if (!orderDetails.items || !Array.isArray(orderDetails.items) || orderDetails.items.length === 0) {
      testResults.failed.push("order_details.items is required for ITEM category");
    } else {
      orderDetails.items.forEach((item: any, index: number) => {
        if (!item.id) testResults.failed.push(`order_details.items[${index}].id is missing`);
      });
      testResults.passed.push(`Order items: ${orderDetails.items.length} item(s)`);
    }
  }

  // Validate fulfillments for FULFILLMENT category
  if (category === "FULFILLMENT") {
    if (!orderDetails.fulfillments || !Array.isArray(orderDetails.fulfillments) || orderDetails.fulfillments.length === 0) {
      testResults.failed.push("order_details.fulfillments is required for FULFILLMENT category");
    } else {
      orderDetails.fulfillments.forEach((fulfillment: any, index: number) => {
        if (!fulfillment.id) testResults.failed.push(`order_details.fulfillments[${index}].id is missing`);
      });
      testResults.passed.push(`Order fulfillments: ${orderDetails.fulfillments.length} fulfillment(s)`);
    }
  }
}

/**
 * Validates description object
 */
export function validateIgm1Description(description: any, testResults: TestResult): void {
  if (!description) {
    testResults.failed.push("issue.description is missing");
    return;
  }

  if (!description.short_desc) {
    testResults.failed.push("description.short_desc is missing");
  } else {
    testResults.passed.push(`Issue description: ${description.short_desc.substring(0, 50)}...`);
  }
}

/**
 * Validates source object
 */
export function validateIgm1Source(source: any, testResults: TestResult): void {
  if (!source) {
    testResults.failed.push("issue.source is missing");
    return;
  }

  if (!source.network_participant_id) {
    testResults.failed.push("source.network_participant_id is missing");
  } else {
    testResults.passed.push(`Source: ${source.network_participant_id}`);
  }

  if (!source.type) {
    testResults.failed.push("source.type is missing");
  } else if (!VALID_IGM1_SOURCE_TYPES.includes(source.type)) {
    testResults.failed.push(`Invalid source.type: ${source.type}. Expected: ${VALID_IGM1_SOURCE_TYPES.join(", ")}`);
  } else {
    testResults.passed.push(`Source type: ${source.type}`);
  }
}

/**
 * Validates issue_actions object
 */
export function validateIgm1IssueActions(issueActions: any, testResults: TestResult): void {
  if (!issueActions) {
    testResults.failed.push("issue.issue_actions is missing");
    return;
  }

  // Validate complainant_actions
  if (issueActions.complainant_actions && Array.isArray(issueActions.complainant_actions)) {
    issueActions.complainant_actions.forEach((action: any, index: number) => {
      if (!action.complainant_action) {
        testResults.failed.push(`complainant_actions[${index}]: complainant_action is missing`);
      } else if (!VALID_IGM1_COMPLAINANT_ACTIONS.includes(action.complainant_action)) {
        testResults.failed.push(`complainant_actions[${index}]: invalid action: ${action.complainant_action}`);
      }
      if (!action.updated_at) testResults.failed.push(`complainant_actions[${index}]: updated_at is missing`);
      if (!action.updated_by) testResults.failed.push(`complainant_actions[${index}]: updated_by is missing`);
    });
    testResults.passed.push(`Complainant actions: ${issueActions.complainant_actions.length} action(s)`);
  }

  // Validate respondent_actions
  if (issueActions.respondent_actions && Array.isArray(issueActions.respondent_actions)) {
    issueActions.respondent_actions.forEach((action: any, index: number) => {
      if (!action.respondent_action) {
        testResults.failed.push(`respondent_actions[${index}]: respondent_action is missing`);
      } else if (!VALID_IGM1_RESPONDENT_ACTIONS.includes(action.respondent_action)) {
        testResults.failed.push(`respondent_actions[${index}]: invalid action: ${action.respondent_action}`);
      }
      if (!action.updated_at) testResults.failed.push(`respondent_actions[${index}]: updated_at is missing`);
      if (!action.updated_by) testResults.failed.push(`respondent_actions[${index}]: updated_by is missing`);
    });
    testResults.passed.push(`Respondent actions: ${issueActions.respondent_actions.length} action(s)`);
  }
}

export function validateIgm1ResolutionProvider(provider: any, testResults: TestResult): void {
  if (!provider) return;

  if (!provider.respondent_info) {
    testResults.failed.push("resolution_provider.respondent_info is missing");
    return;
  }

  const info = provider.respondent_info;
  if (!info.type) {
    testResults.failed.push("resolution_provider.respondent_info.type is missing");
  } else if (!VALID_IGM1_RESPONDENT_TYPES.includes(info.type)) {
    testResults.failed.push(`Invalid respondent_info.type: ${info.type}`);
  } else {
    testResults.passed.push(`Resolution provider type: ${info.type}`);
  }

  if (info.organization?.org?.name) {
    testResults.passed.push(`Resolution provider org: ${info.organization.org.name}`);
  }

  if (info.resolution_support?.phone || info.resolution_support?.email) {
    testResults.passed.push("Resolution support contact present");
  }
}

export function validateIgm1Resolution(resolution: any, testResults: TestResult): void {
  if (!resolution) return;

  if (!resolution.short_desc) {
    testResults.failed.push("resolution.short_desc is missing");
  } else {
    testResults.passed.push(`Resolution: ${resolution.short_desc}`);
  }

  if (!resolution.action_triggered) {
    testResults.failed.push("resolution.action_triggered is missing");
  } else if (!VALID_IGM1_RESOLUTION_ACTIONS.includes(resolution.action_triggered)) {
    testResults.failed.push(`Invalid resolution.action_triggered: ${resolution.action_triggered}`);
  } else {
    testResults.passed.push(`Resolution action: ${resolution.action_triggered}`);
  }
}
