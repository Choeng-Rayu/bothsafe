/**
 * Unit tests for the pure `computeAllowedActions(deal, viewer)`
 * calculator (task 5.5). The function backs
 * `DealService.computeAllowedActions`; its semantics are pinned by
 * R6.3, R9.1, R12.1, R13.1, R17.1, and the design §"Standard
 * `DealRoomResponse` shape → `AllowedAction`" union.
 *
 * The matrix below covers every (status, role) pair so future
 * status additions or role-gate tweaks fail loudly and visibly.
 */

import { computeAllowedActions } from './deal.allowed-actions';
import type { AllowedAction } from '../common/constants';
import { DealStatus, ParticipantRole } from '../common/enums';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a viewer payload for a participant role, with optional approval flag. */
function viewer(
  role: ParticipantRole | null,
  hasApproved = false,
): Parameters<typeof computeAllowedActions>[1] {
  // `user_id` is required by the type but never read by the calculator
  // (it short-circuits on `role === null` or `role === 'admin'`); a
  // synthetic cuid-like string is sufficient for the matrix tests.
  return { user_id: role === null ? null : 'u_test', role, hasApproved };
}

/** Sort for set-equality assertions that ignore declaration order. */
function sortActions(
  actions: readonly AllowedAction[],
): AllowedAction[] {
  return [...actions].sort();
}

// ---------------------------------------------------------------------------
// Anonymous & admin viewers — empty regardless of status (R-prompt rule)
// ---------------------------------------------------------------------------

describe('computeAllowedActions — anonymous viewer', () => {
  it.each(Object.values(DealStatus))(
    'returns [] for an anonymous viewer (status=%s)',
    (status) => {
      expect(
        computeAllowedActions({ status: status as DealStatus }, viewer(null)),
      ).toEqual([]);
    },
  );
});

describe('computeAllowedActions — admin viewer', () => {
  it.each(Object.values(DealStatus))(
    'returns [] for an admin viewer (status=%s) — admin actions live in admin endpoints',
    (status) => {
      expect(
        computeAllowedActions(
          { status: status as DealStatus },
          viewer(ParticipantRole.admin),
        ),
      ).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// DRAFT and AWAITING_COUNTERPARTY — creator side can edit; nobody approves
// (no counterparty yet to approve against).
// ---------------------------------------------------------------------------

describe.each([DealStatus.DRAFT, DealStatus.AWAITING_COUNTERPARTY])(
  'computeAllowedActions — %s',
  (status) => {
    it('lets the buyer-side creator edit product and participant', () => {
      expect(
        computeAllowedActions({ status }, viewer(ParticipantRole.buyer)),
      ).toEqual(['edit_product', 'edit_participant']);
    });

    it('lets the seller-side creator edit product and participant', () => {
      expect(
        computeAllowedActions({ status }, viewer(ParticipantRole.seller)),
      ).toEqual(['edit_product', 'edit_participant']);
    });

    it('does not expose `approve` until the counterparty has joined', () => {
      const result = computeAllowedActions(
        { status },
        viewer(ParticipantRole.buyer),
      );
      expect(result).not.toContain('approve');
    });
  },
);

// ---------------------------------------------------------------------------
// AWAITING_BOTH_APPROVAL — both sides may edit and approve (R8). The
// `approve` button is hidden once the viewer has already approved the
// current terms hash (R8.7 idempotency).
// ---------------------------------------------------------------------------

describe('computeAllowedActions — AWAITING_BOTH_APPROVAL', () => {
  const status = DealStatus.AWAITING_BOTH_APPROVAL;

  it.each([ParticipantRole.buyer, ParticipantRole.seller])(
    'lets %s edit and approve when they have not yet approved',
    (role) => {
      expect(
        sortActions(
          computeAllowedActions({ status }, viewer(role, /*hasApproved*/ false)),
        ),
      ).toEqual(sortActions(['edit_product', 'edit_participant', 'approve']));
    },
  );

  it.each([ParticipantRole.buyer, ParticipantRole.seller])(
    'hides `approve` when %s has already approved the current terms (R8.7)',
    (role) => {
      const result = computeAllowedActions(
        { status },
        viewer(role, /*hasApproved*/ true),
      );
      expect(result).toEqual(['edit_product', 'edit_participant']);
      expect(result).not.toContain('approve');
    },
  );
});

// ---------------------------------------------------------------------------
// READY_FOR_PAYMENT — buyer pays (R9.1, R10.1), seller has no payment
// actions, both can still edit because a material edit reverts to
// AWAITING_BOTH_APPROVAL (R7.3 revert path).
// ---------------------------------------------------------------------------

describe('computeAllowedActions — READY_FOR_PAYMENT', () => {
  const status = DealStatus.READY_FOR_PAYMENT;

  it('exposes pay_from_wallet and pay_khqr to the buyer', () => {
    expect(
      sortActions(
        computeAllowedActions({ status }, viewer(ParticipantRole.buyer)),
      ),
    ).toEqual(
      sortActions([
        'edit_product',
        'edit_participant',
        'pay_from_wallet',
        'pay_khqr',
      ]),
    );
  });

  it('does NOT expose payment actions to the seller', () => {
    const result = computeAllowedActions(
      { status },
      viewer(ParticipantRole.seller),
    );
    expect(result).toEqual(['edit_product', 'edit_participant']);
    expect(result).not.toContain('pay_from_wallet');
    expect(result).not.toContain('pay_khqr');
  });

  it('still allows material edits (R7.3 revert path)', () => {
    expect(
      computeAllowedActions({ status }, viewer(ParticipantRole.seller)),
    ).toContain('edit_product');
  });
});

// ---------------------------------------------------------------------------
// PAYMENT_PENDING_VERIFICATION — buyer can resubmit / refine the receipt;
// seller has no actions; admin verify is its own admin endpoint and does
// NOT appear here.
// ---------------------------------------------------------------------------

describe('computeAllowedActions — PAYMENT_PENDING_VERIFICATION', () => {
  const status = DealStatus.PAYMENT_PENDING_VERIFICATION;

  it('lets the buyer submit a (corrected) KHQR receipt', () => {
    expect(
      computeAllowedActions({ status }, viewer(ParticipantRole.buyer)),
    ).toEqual(['submit_khqr_receipt']);
  });

  it('exposes nothing to the seller', () => {
    expect(
      computeAllowedActions({ status }, viewer(ParticipantRole.seller)),
    ).toEqual([]);
  });

  it('does not surface admin verify/reject (admin actions live elsewhere)', () => {
    const buyer = computeAllowedActions(
      { status },
      viewer(ParticipantRole.buyer),
    );
    expect(buyer).not.toContain(
      'edit_product' as AllowedAction /* sanity */,
    );
  });
});

// ---------------------------------------------------------------------------
// PAID_ESCROWED & SELLER_PREPARING — seller ships, both can dispute.
// ---------------------------------------------------------------------------

describe.each([DealStatus.PAID_ESCROWED, DealStatus.SELLER_PREPARING])(
  'computeAllowedActions — %s',
  (status) => {
    it('lets the seller submit shipping proof and open a dispute', () => {
      expect(
        sortActions(
          computeAllowedActions({ status }, viewer(ParticipantRole.seller)),
        ),
      ).toEqual(sortActions(['submit_shipping_proof', 'open_dispute']));
    });

    it('lets the buyer open a dispute but not ship', () => {
      const result = computeAllowedActions(
        { status },
        viewer(ParticipantRole.buyer),
      );
      expect(result).toEqual(['open_dispute']);
      expect(result).not.toContain('submit_shipping_proof');
    });
  },
);

// ---------------------------------------------------------------------------
// SHIPPED — buyer confirms or disputes; seller can dispute (e.g., the
// buyer is unreachable and the seller wants admin involvement).
// ---------------------------------------------------------------------------

describe('computeAllowedActions — SHIPPED', () => {
  const status = DealStatus.SHIPPED;

  it('lets the buyer confirm received and open a dispute', () => {
    expect(
      sortActions(
        computeAllowedActions({ status }, viewer(ParticipantRole.buyer)),
      ),
    ).toEqual(sortActions(['confirm_received', 'open_dispute']));
  });

  it('lets the seller open a dispute but not confirm', () => {
    const result = computeAllowedActions(
      { status },
      viewer(ParticipantRole.seller),
    );
    expect(result).toEqual(['open_dispute']);
    expect(result).not.toContain('confirm_received');
  });
});

// ---------------------------------------------------------------------------
// BUYER_CONFIRMED, RELEASE_PENDING — auto-release in flight, no participant
// actions. DISPUTED — admin-only resolution.
// ---------------------------------------------------------------------------

describe.each([
  DealStatus.BUYER_CONFIRMED,
  DealStatus.RELEASE_PENDING,
  DealStatus.DISPUTED,
])('computeAllowedActions — %s (no participant actions)', (status) => {
  it.each([ParticipantRole.buyer, ParticipantRole.seller])(
    'returns [] for %s',
    (role) => {
      expect(computeAllowedActions({ status }, viewer(role))).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Terminal statuses — empty by definition.
// ---------------------------------------------------------------------------

describe.each([
  DealStatus.RELEASED,
  DealStatus.REFUNDED,
  DealStatus.CANCELLED,
  DealStatus.EXPIRED,
])('computeAllowedActions — %s (terminal)', (status) => {
  it.each([ParticipantRole.buyer, ParticipantRole.seller])(
    'returns [] for %s',
    (role) => {
      expect(computeAllowedActions({ status }, viewer(role))).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Coverage matrix — single test that asserts the full (status × role)
// table at once. Keeps any silent regression visible as a single diff.
// ---------------------------------------------------------------------------

describe('computeAllowedActions — coverage matrix', () => {
  // Use plain string keys so the snapshot below stays human-readable
  // even if a status enum value is renamed.
  type Row = {
    status: DealStatus;
    buyer: AllowedAction[];
    seller: AllowedAction[];
  };

  const matrix: Row[] = [
    {
      status: DealStatus.DRAFT,
      buyer: ['edit_product', 'edit_participant'],
      seller: ['edit_product', 'edit_participant'],
    },
    {
      status: DealStatus.AWAITING_COUNTERPARTY,
      buyer: ['edit_product', 'edit_participant'],
      seller: ['edit_product', 'edit_participant'],
    },
    {
      status: DealStatus.AWAITING_BOTH_APPROVAL,
      // hasApproved=false in the matrix; the toggled-on case is covered above.
      buyer: ['edit_product', 'edit_participant', 'approve'],
      seller: ['edit_product', 'edit_participant', 'approve'],
    },
    {
      status: DealStatus.READY_FOR_PAYMENT,
      buyer: [
        'edit_product',
        'edit_participant',
        'pay_from_wallet',
        'pay_khqr',
      ],
      seller: ['edit_product', 'edit_participant'],
    },
    {
      status: DealStatus.PAYMENT_PENDING_VERIFICATION,
      buyer: ['submit_khqr_receipt'],
      seller: [],
    },
    {
      status: DealStatus.PAID_ESCROWED,
      buyer: ['open_dispute'],
      seller: ['submit_shipping_proof', 'open_dispute'],
    },
    {
      status: DealStatus.SELLER_PREPARING,
      buyer: ['open_dispute'],
      seller: ['submit_shipping_proof', 'open_dispute'],
    },
    {
      status: DealStatus.SHIPPED,
      buyer: ['confirm_received', 'open_dispute'],
      seller: ['open_dispute'],
    },
    { status: DealStatus.BUYER_CONFIRMED, buyer: [], seller: [] },
    { status: DealStatus.RELEASE_PENDING, buyer: [], seller: [] },
    { status: DealStatus.DISPUTED, buyer: [], seller: [] },
    { status: DealStatus.RELEASED, buyer: [], seller: [] },
    { status: DealStatus.REFUNDED, buyer: [], seller: [] },
    { status: DealStatus.CANCELLED, buyer: [], seller: [] },
    { status: DealStatus.EXPIRED, buyer: [], seller: [] },
  ];

  it('covers every DealStatus value (no enum drift)', () => {
    const allStatuses = new Set<string>(Object.values(DealStatus));
    const matrixStatuses = new Set(matrix.map((r) => r.status));
    expect(matrixStatuses).toEqual(allStatuses);
  });

  it.each(matrix)(
    'matches the expected actions at status=$status',
    ({ status, buyer, seller }) => {
      expect(
        sortActions(
          computeAllowedActions({ status }, viewer(ParticipantRole.buyer)),
        ),
      ).toEqual(sortActions(buyer));
      expect(
        sortActions(
          computeAllowedActions({ status }, viewer(ParticipantRole.seller)),
        ),
      ).toEqual(sortActions(seller));
    },
  );
});
