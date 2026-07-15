-- =====================================================================
-- Service Marketplace / Product Marketplace / Bidding Platform
-- Database Schema (PostgreSQL)
-- Extracted from: Task 1 - System Architecture & Design (Gayu, 13 July 2026)
-- Source: Section 2 - Database Schema
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- =====================================================================
-- 2.1 SHARED / CROSS-MODULE TABLES
-- =====================================================================

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,          -- bcrypt / argon2
    role            VARCHAR(50)  NOT NULL DEFAULT 'user',
                    -- base role for admin-panel access only;
                    -- per-context role (Provider/Client/Vendor/Requester/Bidder)
                    -- is inferred from which table references the user (see §4.3)
    created_at      TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_email ON users(email);

CREATE TABLE message_threads (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id       UUID NOT NULL REFERENCES message_threads(id),
    sender_id       UUID NOT NULL REFERENCES users(id),
    body            TEXT NOT NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_thread ON messages(thread_id);

CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    type            VARCHAR(100) NOT NULL,          -- order_accepted, bid_received, dispute_opened, ...
    payload         JSONB NOT NULL,                 -- reference ids + display data
    read_at         TIMESTAMP NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user ON notifications(user_id);


-- =====================================================================
-- 2.2 MODULE 1 - SERVICE MARKETPLACE (listings, orders, escrow)
-- =====================================================================

CREATE TABLE listings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id     UUID NOT NULL REFERENCES users(id),
    title           VARCHAR(255) NOT NULL,
    description     TEXT,
    price           DECIMAL(12,2) NOT NULL,
    category        VARCHAR(100) NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive'))
);
CREATE INDEX idx_listings_category ON listings(category); -- indexed for filter

-- orders is shared across Module 1 & Module 3 via a polymorphic
-- source_type/source_id pair, rather than one orders table per module.
CREATE TABLE orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_type     VARCHAR(10) NOT NULL CHECK (source_type IN ('listing', 'bid')),
    source_id       UUID NOT NULL,       -- app-level ref to listings.id or bids.id
                                          -- (not a DB FK, since it's polymorphic)
    client_id       UUID NOT NULL REFERENCES users(id),
    provider_id     UUID NOT NULL REFERENCES users(id),
    amount          DECIMAL(12,2) NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                        'pending', 'accepted', 'declined',
                        'funded', 'held', 'delivered',
                        'completed', 'disputed'
                    )),
    version         INT NOT NULL DEFAULT 0,          -- optimistic lock;
                                                       -- incremented on every status change
    created_at      TIMESTAMP NOT NULL DEFAULT now(),
    updated_at      TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_source ON orders(source_type, source_id);
CREATE INDEX idx_orders_client ON orders(client_id);
CREATE INDEX idx_orders_provider ON orders(provider_id);

-- Append-only fund-custody ledger. Every write to orders.status happens in the
-- same DB transaction as the matching ledger_entries insert (see §2.2 note).
CREATE TABLE ledger_entries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id),
    actor_id        UUID NOT NULL REFERENCES users(id),   -- who triggered it
    action          VARCHAR(20) NOT NULL
                    CHECK (action IN ('fund', 'hold', 'release', 'dispute', 'resolve')),
    amount          DECIMAL(12,2) NOT NULL,
    state_before    VARCHAR(20) NOT NULL,   -- order status before this entry
    state_after     VARCHAR(20) NOT NULL,   -- order status after this entry
    created_at      TIMESTAMP NOT NULL DEFAULT now()   -- append-only, never updated
);
CREATE INDEX idx_ledger_order ON ledger_entries(order_id);

CREATE TABLE disputes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id),
    raised_by       UUID NOT NULL REFERENCES users(id),
    resolved_by     UUID NULL REFERENCES users(id),        -- admin, nullable until resolved
    reason          TEXT NOT NULL,
    resolution      VARCHAR(30) NOT NULL DEFAULT 'pending'
                    CHECK (resolution IN ('released_to_provider', 'refunded_to_client', 'pending')),
    created_at      TIMESTAMP NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMP NULL
);
CREATE INDEX idx_disputes_order ON disputes(order_id);


-- =====================================================================
-- 2.3 MODULE 2 - PRODUCT MARKETPLACE (catalog, cart, inventory)
-- =====================================================================

CREATE TABLE products (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id       UUID NOT NULL REFERENCES users(id),
    sku             VARCHAR(100) NOT NULL,     -- unique per vendor
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    unit_price      DECIMAL(12,2) NOT NULL,
    unit_of_measure VARCHAR(50) NOT NULL,      -- box / unit / ton
    available_qty   INT NOT NULL DEFAULT 0,    -- decremented atomically on order
    version         INT NOT NULL DEFAULT 0,    -- optimistic lock
    UNIQUE (vendor_id, sku)
);

CREATE TABLE cart_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_id        UUID NOT NULL REFERENCES users(id),
    product_id      UUID NOT NULL REFERENCES products(id),
    quantity        INT NOT NULL CHECK (quantity > 0)
);
CREATE INDEX idx_cart_items_buyer ON cart_items(buyer_id);

CREATE TABLE order_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id            UUID NOT NULL REFERENCES orders(id),
    product_id          UUID NOT NULL REFERENCES products(id),
    quantity            INT NOT NULL,
    unit_price          DECIMAL(12,2) NOT NULL,   -- price snapshotted at order time
    fulfillment_status  VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (fulfillment_status IN ('pending', 'partial', 'fulfilled', 'backordered'))
);
CREATE INDEX idx_order_items_order ON order_items(order_id);

-- Overselling prevention (see §2.3 design note):
--   UPDATE products
--   SET available_qty = available_qty - :qty, version = version + 1
--   WHERE id = :id AND available_qty >= :qty;
-- If 0 rows affected -> 409, caller retries / order rejected.
-- Multi-item orders wrap all product decrements in a single DB transaction.


-- =====================================================================
-- 2.4 MODULE 3 - BIDDING SYSTEM (project requests, competitive bids)
-- =====================================================================

CREATE TABLE project_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id    UUID NOT NULL REFERENCES users(id),
    description     TEXT NOT NULL,
    budget_min      DECIMAL(12,2),
    budget_max      DECIMAL(12,2),
    deadline        TIMESTAMP NOT NULL,        -- bids auto-expire after this
    status          VARCHAR(20) NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'closed', 'expired'))
);
CREATE INDEX idx_project_requests_requester ON project_requests(requester_id);

CREATE TABLE bids (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id              UUID NOT NULL REFERENCES project_requests(id),
    bidder_id               UUID NOT NULL REFERENCES users(id),
    price                   DECIMAL(12,2) NOT NULL,
    message                 TEXT,
    estimated_completion    DATE,
    status                  VARCHAR(20) NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'accepted', 'rejected', 'expired', 'countered')),
    parent_bid_id            UUID NULL REFERENCES bids(id)
                            -- self-FK, nullable - set when this bid is a
                            -- counter-offer (negotiation thread, bonus feature)
);
CREATE INDEX idx_bids_request ON bids(request_id);
CREATE INDEX idx_bids_bidder ON bids(bidder_id);

-- Bid expiry uses lazy expiration on read (deadline < now()) plus a
-- lightweight scheduled job every 5-15 min to flip stored status;
-- see §2.4 design note for the consistency trade-off.

-- =====================================================================
-- End of schema
-- =====================================================================
