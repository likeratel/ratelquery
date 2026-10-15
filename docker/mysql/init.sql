-- Seed data for local development. Loaded once when the volume is created.
USE sample;

CREATE TABLE customers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  tier ENUM('free', 'pro', 'enterprise') NOT NULL DEFAULT 'free',
  balance DECIMAL(12, 2) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  signed_up_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  profile JSON NULL
) ENGINE=InnoDB;

CREATE TABLE orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id INT UNSIGNED NOT NULL,
  status VARCHAR(20) NOT NULL,
  total DECIMAL(12, 2) NOT NULL,
  placed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note TEXT NULL,
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
  INDEX idx_orders_customer (customer_id),
  INDEX idx_orders_placed (placed_at)
) ENGINE=InnoDB;

CREATE TABLE audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  entity VARCHAR(50) NOT NULL,
  entity_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(20) NOT NULL,
  payload JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE no_primary_key (
  label VARCHAR(50) NOT NULL,
  value INT NOT NULL
) ENGINE=InnoDB;

INSERT INTO customers (email, name, tier, balance, profile) VALUES
  ('ada@example.com', 'Ada Lovelace', 'enterprise', 1200.50, JSON_OBJECT('lang', 'en', 'tags', JSON_ARRAY('math', 'poetry'))),
  ('grace@example.com', 'Grace Hopper', 'pro', 300.00, JSON_OBJECT('lang', 'en')),
  ('linus@example.com', 'Linus Torvalds', 'free', 0, NULL),
  ('margaret@example.com', 'Margaret Hamilton', 'pro', 42.42, JSON_OBJECT('lang', 'en', 'tags', JSON_ARRAY('apollo'))),
  ('세종@example.com', '세종대왕', 'enterprise', 9999.99, JSON_OBJECT('lang', 'ko'));

INSERT INTO orders (customer_id, status, total, note) VALUES
  (1, 'paid', 99.00, 'first order'),
  (1, 'shipped', 149.50, NULL),
  (2, 'paid', 19.99, 'gift'),
  (4, 'refunded', 42.42, '한글 메모'),
  (5, 'paid', 1000.00, NULL);

INSERT INTO audit_log (entity, entity_id, action, payload) VALUES
  ('customer', 1, 'create', JSON_OBJECT('by', 'seed')),
  ('order', 1, 'create', JSON_OBJECT('by', 'seed'));

INSERT INTO no_primary_key (label, value) VALUES ('a', 1), ('a', 1), ('b', 2);
