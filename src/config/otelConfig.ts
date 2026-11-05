// Enable strict mode automatically in ES modules
import dotenv from 'dotenv';
dotenv.config();
import logger from "@ondc/automation-logger";
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
// With no TRACE_URL configured, OTLPTraceExporter falls back to OTel's
// default collector endpoint, which nothing is listening on here. Every
// batch export then fails, so spans pile up unexported in the
// BatchSpanProcessor queue (getNodeAutoInstrumentations() generates one for
// every http/https/express/etc. operation, including each of the ~150+
// axios calls a single report-generation request makes) and the failure
// gets logged — printing that queue (each span holds a circular
// `_spanProcessor` back-reference to the processor holding the whole
// queue) is a real, synchronous, CPU-heavy serialization, not a network
// wait. Skip starting the SDK entirely when there's no real collector to
// send to, rather than instrumenting everything for nowhere to go.
if (process.env.TRACE_URL) {
  logger.info('Starting opentelemetry tracing');

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.SERVICE_NAME,
  });

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({
      url: process.env.TRACE_URL
    }),
    instrumentations: [getNodeAutoInstrumentations()],
    resource,
  });

  sdk.start();
} else {
  logger.info('TRACE_URL not set — skipping OpenTelemetry tracing setup');
}
