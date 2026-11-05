import { writeFileSync } from "fs";
import { FlowValidationResult, ParsedMessage, Report } from "../types/payload";
import logger from "@ondc/automation-logger";

// Helper function to generate API validation section HTML
function generateApiValidationHtml(
  api: string,
  ackStatus: string | null,
  errorCode: string | undefined,
  errorMessage: string | undefined,
  passed: string[],
  failed: string[]
): string {
  // Transform dynamic_form_1, dynamic_form_2, etc. to form1, form2, etc.
  let displayName = api;
  const dynamicFormMatch = api.match(/^dynamic_form_(\d+)$/);
  if (dynamicFormMatch) {
    displayName = `form${dynamicFormMatch[1]}`;
  }

  let ackHtml = "";
  if (ackStatus) {
    const ackClass =
      ackStatus === "ACK" ? "ack" : ackStatus === "NACK" ? "nack" : "no-response";
    ackHtml = `<span class="ack-status ${ackClass}">${ackStatus}</span>`;
    if (ackStatus === "NACK" && errorCode && errorMessage) {
      ackHtml += `<span class="error-details">${errorCode}: ${errorMessage}</span>`;
    }
  }

  const passedHtml = passed
    .map(
      (item) =>
        `<li class="result-item passed"><span class="icon pass">✔</span>${item}</li>`
    )
    .join("");

  const failedHtml = failed
    .map(
      (item) =>
        `<li class="result-item failed"><span class="icon fail">✘</span>${item}</li>`
    )
    .join("");

  return `
    <div class="api-header">
      <span>${displayName}</span>
      <div class="right-section">
        ${ackHtml}
      </div>
    </div>
    <ul class="result-list">
      ${passedHtml}
      ${failedHtml}
    </ul>
  `;
}

// Generate the HTML report
export function generateCustomHTMLReport(data: Report, sessionId: string, flowMap: Record<string, string>): { html: string; flowResults: Record<string, "PASS" | "FAIL"> } {
  const styles = `
    <style>
      body {
        font-family: Arial, sans-serif;
        margin: 0;
        padding: 20px;
        background-color: #f7f7f7;
        color: #333;
      }
      h1 {
        text-align: center;
        color: #0056a6;
        margin-bottom: 30px;
        font-size: 26px;
      }
      .flow-card {
        background: #fff;
        margin-bottom: 25px;
        padding: 15px;
        border-radius: 8px;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        border: 1px solid #ddd;
        margin-top: 15px;
      }
      .flow-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        cursor: pointer;
        padding: 10px 5px;
        border-radius: 6px;
        transition: background-color 0.2s ease;
      }
      .flow-header:hover {
        background-color: #f0f4f8;
      }
      .flow-header-left {
        display: flex;
        align-items: center;
        gap: 12px;
        flex: 1;
      }
      .flow-header-right {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .flow-id {
        max-width: 100%; 
        font-size: 18px;
        font-weight: bold;
        color: #0056a6;
        overflow: hidden;
        white-space: normal;
        display: block;
      }
      .txn-id {
      	font-size: 14px;
      	color: #666;
      	font-weight: normal;
      	margin-left: 8px;
      }
      .arrow-icon {
        font-size: 18px;
        color: #0056a6;
        transition: transform 0.3s ease;
        user-select: none;
        min-width: 24px;
        text-align: center;
      }
      .arrow-icon.expanded {
        transform: rotate(180deg);
      }
      .validity {
        font-size: 14px;
        padding: 5px 12px;
        border-radius: 18px;
        color: #fff;
        font-weight: bold;
      }
      .validity.valid {
        background-color: #28a745;
      }
      .validity.invalid {
        background-color: #dc3545;
      }
      .flow-content {
        max-height: 0;
        overflow: hidden;
        transition: max-height 0.4s ease-out, padding 0.3s ease;
        padding: 0 5px;
      }
      .flow-content.expanded {
        max-height: 999999px;
        overflow: visible;
        padding: 15px 5px;
        transition: max-height 0.6s ease-in;
      }
      .section-title {
        font-size: 15px;
        font-weight: bold;
        margin-top: 15px;
        color: #333;
        margin-bottom: 8px;
      }
      .api-header {
        font-size: 15px;
        font-weight: bold;
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 12px;
        margin-bottom: 10px;
      }
      .api-header .right-section {
        display: flex;
        align-items: center;
      }
      .ack-status {
        font-size: 12px;
        padding: 4px 8px;
        border-radius: 18px;
        color: #fff;
        font-weight: bold;
        margin-left: 10px;
      }
      .ack-status.ack {
        background-color: #4caf50;
      }
      .ack-status.nack {
        background-color: #D9534F;
      }
      .ack-status.no-response {
        background-color: #5bc0de;
      }
      .error-details {
        font-size: 12px;
        color: #721c24;
        background-color: #fce8e6;
        padding: 4px 8px;
        border-radius: 4px;
        margin-left: 10px;
        display: inline-block;
      }
      .result-list {
        max-width: 100%;
        width: 100%;
        list-style: none;
        padding: 0;
        margin: 0;
      }
      .result-item {
        display: flex;
        align-items: center;
        padding: 6px 15px;
        margin-bottom: 8px;
        border-radius: 6px;
        font-size: 14px;
        border: 1px solid #ddd;
        word-wrap: break-word;
        word-break: break-word;
        overflow-wrap: break-word;
        white-space: normal;
        overflow: hidden;
        max-width: 100%;
      }
      .result-item.passed {
        background-color: #e7f9ed;
        border-color: #28a745;
        color: #155724;
      }
      .result-item.failed {
        background-color: #fce8e6;
        border-color: #dc3545;
        color: #721c24;
      }
      .icon {
        margin-right: 8px;
        font-size: 16px;
      }
      .icon.pass {
        color: #28a745;
      }
      .icon.fail {
        color: #dc3545;
      }
      .controls {
        display: flex;
        justify-content: flex-end;
        margin-bottom: 15px;
        gap: 10px;
      }
      .control-btn {
        background-color: #0056a6;
        color: #fff;
        border: none;
        padding: 8px 16px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
        transition: background-color 0.2s ease;
      }
      .control-btn:hover {
        background-color: #003d7a;
      }
      .session-id-header {
      	text-align: center;
      	color: #555;
      	font-size: 16px;
      	margin-bottom: 30px;
      }
      .copy-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 2px 6px;
        margin-left: 6px;
        border-radius: 4px;
        color: #666;
        transition: background-color 0.2s, color 0.2s;
        font-size: 14px;
      }
      .copy-btn:hover {
        background-color: #e0e0e0;
        color: #333;
      }
    </style>
  `;

  const script = `
    <script>
      function copyToClipboard(buttonElement, textToCopy, event) {
          // Prevent event from bubbling up to the accordion header click
          event.stopPropagation();
          
          navigator.clipboard.writeText(textToCopy).then(() => {
              const originalText = buttonElement.innerHTML;
              buttonElement.innerHTML = '✅';
              setTimeout(() => {
                  buttonElement.innerHTML = originalText;
              }, 2000);
          }).catch(err => {
              console.error('Failed to copy text: ', err);
          });
      }
      function toggleAccordion(id) {
        const content = document.getElementById(id);
        const arrow = document.getElementById('arrow-' + id);
        
        if (content.classList.contains('expanded')) {
          content.classList.remove('expanded');
          arrow.classList.remove('expanded');
          arrow.textContent = '▼';
        } else {
          content.classList.add('expanded');
          arrow.classList.add('expanded');
          arrow.textContent = '▲';
        }
      }
      
      function expandAll() {
        const contents = document.querySelectorAll('.flow-content');
        const arrows = document.querySelectorAll('.arrow-icon');
        
        contents.forEach(content => {
          content.classList.add('expanded');
        });
        arrows.forEach(arrow => {
          arrow.classList.add('expanded');
          arrow.textContent = '▲';
        });
      }
      
      function collapseAll() {
        const contents = document.querySelectorAll('.flow-content');
        const arrows = document.querySelectorAll('.arrow-icon');
        
        contents.forEach(content => {
          content.classList.remove('expanded');
        });
        arrows.forEach(arrow => {
          arrow.classList.remove('expanded');
          arrow.textContent = '▼';
        });
      }
      function downloadReport() {
        const contents = document.querySelectorAll('.flow-content');
        const arrows = document.querySelectorAll('.arrow-icon');

        contents.forEach(content => content.classList.add('expanded'));
        arrows.forEach(arrow => {
          arrow.classList.add('expanded');
          arrow.textContent = '▲';
        });

        const htmlContent = document.documentElement.outerHTML;

        const blob = new Blob([htmlContent], { type: "text/html" });
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = "Flow_Validation_Report.html";
        document.body.appendChild(a);
        a.click();

        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    </script>
  `;

  // Generate final report summary section
  const finalReportHtml = Object.entries(data?.finalReport || {}).length
    ? `<ul class="result-list">${Object.entries(data?.finalReport)
      .map(([key, value]) =>
        key.length > 0
          ? `<li class="result-item failed"><span class="icon fail">✘</span>${value}</li>`
          : ""
      )
      .join("")}</ul>`
    : "<p>All flows have been tested</p>";

  // Generate flow cards HTML
  const flowResults: Record<string, "PASS" | "FAIL"> = {};
  const flowCardsHtml = Object.entries(data?.flowErrors || {})
    .map(([flowId, { valid_flow, errors, messages }], index) => {
      const parsedMessages: Record<string, ParsedMessage> = Object.entries(
        messages
      ).reduce((acc, [api, result]) => {
        try {
          const parsedResult = JSON.parse(result);
          acc[api] = {
            ackStatus:
              parsedResult.response?.message?.ack?.status || "invalid response",
            errorCode:
              parsedResult.response?.error?.code || "No code available",
            errorMessage:
              parsedResult.response?.error?.message || "No message available",
            passed: parsedResult.passed || [],
            failed: parsedResult.failed || [],
          };
        } catch {
          acc[api] = {
            ackStatus: null,
            errorCode: "Parsing error",
            errorMessage: "Could not parse response",
            passed: [],
            failed: [],
          };
        }
        return acc;
      }, {} as Record<string, ParsedMessage>);

      // A flow only actually passes if the action sequence matched AND no
      // individual action reported a validation failure — valid_flow alone
      // only reflects sequence order, not business/schema correctness.
      const hasValidationFailures = Object.values(parsedMessages).some(
        (m) => Array.isArray(m.failed) && m.failed.length > 0
      );
      const flowPassed = valid_flow && !hasValidationFailures;
      flowResults[flowId] = flowPassed ? "PASS" : "FAIL";

      // Generate errors list
      const errorsHtml = errors.length
        ? `<ul class="result-list">${errors
          .map(
            (err) =>
              `<li class="result-item failed"><span class="icon fail">✘</span>${err}</li>`
          )
          .join("")}</ul>`
        : "<p>No errors found.</p>";

      // Generate API validations HTML
      const apiValidationsHtml = Object.entries(parsedMessages)
        .map(([api, { ackStatus, errorCode, errorMessage, passed, failed }]) =>
          generateApiValidationHtml(
            api,
            ackStatus,
            errorCode,
            errorMessage,
            passed,
            failed
          )
        )
        .join("");

      const txnId = flowMap[flowId] || 'N/A';
      return `
        <div class="flow-card">
          <div class="flow-header" onclick="toggleAccordion('flow-${index}')">
            <div class="flow-header-left">
              <span class="arrow-icon" id="arrow-flow-${index}">▼</span>
              <div class="flow-id">
                Flow ID: ${flowId}
                <span class="txn-id">(Txn ID: ${txnId})</span>
                <button class="copy-btn" onclick="copyToClipboard(this, '${txnId}', event)" title="Copy Transaction ID">📋</button>
              </div>
            </div>
            <div class="flow-header-right">
              <div class="validity ${flowPassed ? "valid" : "invalid"}">
                ${flowPassed ? "Valid" : "Invalid"}
              </div>
            </div>
          </div>
          <div class="flow-content" id="flow-${index}">
            <div class="section">
              <div class="section-title">Flow Sequence Errors</div>
              ${errorsHtml}
            </div>
            <div class="section">
              <div class="section-title">Validation Errors</div>
              ${apiValidationsHtml}
            </div>
          </div>
        </div>
      `;
    })
    .join("");

logger.info("flowResultsForPASSFAIL",JSON.stringify(flowResults))
  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Flow Validation Report</title>
      ${styles}
    </head>
    <body>
      <h1>Flow Validation Report</h1>
      
      <!-- Control Buttons -->
      <div class="controls">
        <button class="control-btn" onclick="downloadReport()">⬇ Download Report</button>
        <button class="control-btn" onclick="expandAll()">▼ Expand All</button>
        <button class="control-btn" onclick="collapseAll()">▲ Collapse All</button>
      </div>

      <div class="session-id-header">
    	Session ID: <strong>${sessionId}</strong>
        <button class="copy-btn" onclick="copyToClipboard(this, '${sessionId}', event)" title="Copy Session ID">📋</button>
      </div>
      
      <div class="flow-card">
        <div class="section">
          <div class="flow-id">Report Summary</div>
          ${finalReportHtml}
        </div>
      </div>
      
      ${flowCardsHtml}
      
      ${script}
    </body>
    </html>
  `;

  return { html: htmlContent, flowResults };
}
