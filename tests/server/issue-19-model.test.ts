import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewQueueSchema, reviewReasons, returnViewSchema } from '../../src/features/returns/model';
import { stalledReviewReasons } from '../../src/features/stalled-review/model';

// Every value the exchange_review_items reason check accepts (issues 9, 13, 19).
const sqlReasons = ['missing_return_confirmation', 'overdue_return', 'missing_help_confirmation', 'unresolved_dispute'];
const id = '11111111-1111-4111-8111-111111111111';

test('Every review reason the database can write has a label and parses in the return view and review queue', () => {
  for (const reason of sqlReasons) {
    assert.ok(reviewReasons[reason as keyof typeof reviewReasons], `reviewReasons is missing ${reason}`);
    assert.ok(stalledReviewReasons[reason], `stalledReviewReasons is missing ${reason}`);
    assert.doesNotThrow(() => returnViewSchema.shape.review.parse([{ reason, queued_at: '2026-10-18T00:00:00Z' }]));
    assert.doesNotThrow(() => reviewQueueSchema.parse([{ id, exchange_id: id, community_id: id, reason, queued_at: '2026-10-18T00:00:00Z', communities: null }]));
  }
});
