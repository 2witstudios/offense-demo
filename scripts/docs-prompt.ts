#!/usr/bin/env bun
import { DOCUMENT_PIPELINES, type DocumentPipeline } from './docs-pipeline';
import { promptFor } from './docs-prompts';

const pipeline = process.argv[2] as DocumentPipeline | undefined;
if (!pipeline || !DOCUMENT_PIPELINES.includes(pipeline)) {
  process.stderr.write(
    `Usage: bun docs:prompt <${DOCUMENT_PIPELINES.join('|')}>\n`,
  );
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(promptFor(pipeline), null, 2)}\n`);
