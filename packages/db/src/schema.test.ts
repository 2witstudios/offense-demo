import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { oneOf } from './schema/columns';
import { sessions } from './schema/auth';
import { emailDeliveries } from './schema/email-delivery';
import { outbox } from './schema/outbox';
import { projects, projectStatuses } from './schema/projects';
import { users } from './schema/users';

setupRitewayBun();

/**
 * The constraint and index names the integration suites and their negative
 * controls refer to (ADR 0029). A renamed rule fails here before it fails
 * against PostgreSQL.
 */
const rules = (table: PgTable) => {
  const config = getTableConfig(table);
  return {
    checks: config.checks.map((check) => check.name).sort(),
    indexes: config.indexes
      .map(
        (index) =>
          `${index.config.unique ? 'unique ' : ''}${index.config.name}`,
      )
      .sort(),
    uniques: config.uniqueConstraints.map((unique) => unique.name).sort(),
    // Only explicitly named keys: drizzle-orm 1.0's `getName()` default
    // (`…_fk`) differs from the `…_fkey` name drizzle-kit 1.0 generates, so
    // default names are checked against PostgreSQL in
    // integration/baseline.integration.ts instead.
    namedKeys: config.foreignKeys
      .map((key) => key.reference().name)
      .filter((name): name is string => name !== undefined)
      .sort(),
  };
};

describe('platform schema rules', () => {
  test('users carry the tombstone, version and case-folded username rules', () => {
    assert({
      given: 'the users table',
      should:
        'declare the tombstone and version CHECKs and the unique email and lower(username) indexes',
      actual: rules(users),
      expected: {
        checks: ['users_tombstone_scrubbed', 'users_version_positive'],
        indexes: [
          'unique users_email_unique',
          'unique users_username_lower_unique',
        ],
        uniques: [],
        namedKeys: [],
      },
    });
  });

  test('sessions and email deliveries carry the indexes the retention sweep reads', () => {
    assert({
      given: 'the session and email_delivery tables',
      should: 'index the column each retention sweep orders by',
      actual: {
        session: rules(sessions).indexes,
        emailDelivery: rules(emailDeliveries).indexes,
      },
      expected: {
        session: [
          'session_expires_at_idx',
          'session_user_id_idx',
          'unique session_token_unique',
        ],
        emailDelivery: [
          'email_delivery_recipient_idx',
          'email_delivery_updated_at_idx',
          'unique email_delivery_provider_message_unique',
        ],
      },
    });
  });

  test('the outbox is commit-ordered and refuses non-object payloads', () => {
    assert({
      given: 'the outbox table',
      should:
        'index (txid, seq), topic and created_at and CHECK the payload shape',
      actual: rules(outbox),
      expected: {
        checks: ['outbox_payload_is_object'],
        indexes: [
          'outbox_created_at_idx',
          'outbox_topic_idx',
          'outbox_txid_seq_idx',
        ],
        uniques: [],
        namedKeys: [],
      },
    });
  });

  test('projects carry the status vocabulary, the version rule and the owner index (PROJ-1.1)', () => {
    const config = getTableConfig(projects);
    const dialect = new PgDialect();
    const statusCheck = config.checks.find(
      (check) => check.name === 'projects_status_check',
    );
    const ownerIndex = config.indexes.find(
      (index) => index.config.name === 'projects_owner_user_id_idx',
    );
    assert({
      given: 'the projects table',
      should:
        'declare projects_status_check built with oneOf over the schema vocabulary, projects_version_positive and a full owner_user_id index',
      actual: {
        ...rules(projects),
        statusVocabulary: projectStatuses,
        statusCheckSql:
          statusCheck && dialect.sqlToQuery(statusCheck.value).sql,
        ownerIndex: ownerIndex && {
          columns: ownerIndex.config.columns.map(
            (column) => (column as { name: string }).name,
          ),
          partial: ownerIndex.config.where !== undefined,
        },
      },
      expected: {
        checks: ['projects_status_check', 'projects_version_positive'],
        indexes: ['projects_owner_user_id_idx'],
        uniques: [],
        namedKeys: [],
        statusVocabulary: ['active', 'archived'],
        statusCheckSql: dialect.sqlToQuery(
          oneOf(projects.status, projectStatuses),
        ).sql,
        ownerIndex: { columns: ['owner_user_id'], partial: false },
      },
    });
  });
});
