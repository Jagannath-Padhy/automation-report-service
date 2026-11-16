import { Payload, TestResult } from "../../types/payload";
import { createDomainValidator } from "../shared/baseValidator";
import { checkJsonResponse } from "../shared/schemaValidator";

const resolveVersion = (element: Payload) =>
  element?.jsonRequest?.context?.version || element?.jsonRequest?.context?.core_version;

const checkJsonResponseWithSchema = (jsonResponse: any, testResults: TestResult) =>
  checkJsonResponse(jsonResponse, testResults);

export const validate = createDomainValidator(resolveVersion, checkJsonResponseWithSchema);
