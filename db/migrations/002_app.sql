-- App Moyo Farmácia: produtos, stock, dispensações e inventários

ALTER TABLE pharmacies ADD COLUMN next_sku integer NOT NULL DEFAULT 1;

CREATE TYPE movement_type         AS ENUM ('ENTRADA', 'SAIDA', 'DISPENSACAO', 'AJUSTE_INVENTARIO');
CREATE TYPE inventory_status      AS ENUM ('AGENDADO', 'EM_CURSO', 'CONCLUIDO', 'FECHADO');
CREATE TYPE inventory_item_status AS ENUM ('PENDENTE', 'CONTADO', 'APROVADO', 'REJEITADO');

-- ---------- Produtos (cada farmácia tem o seu catálogo e o seu stock) ----------
CREATE TABLE products (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id           uuid NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  sku                   varchar(40)  NOT NULL,
  barcode               varchar(64),
  name                  varchar(200) NOT NULL,
  category              varchar(80),
  price                 numeric(14,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  stock_qty             integer NOT NULL DEFAULT 0,          -- pode ficar negativo após sincronização offline
  min_stock             integer NOT NULL DEFAULT 5 CHECK (min_stock >= 0),
  requires_prescription boolean NOT NULL DEFAULT false,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);
CREATE UNIQUE INDEX ux_products_sku     ON products (pharmacy_id, upper(sku)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ux_products_barcode ON products (pharmacy_id, barcode)    WHERE deleted_at IS NULL AND barcode IS NOT NULL;
CREATE INDEX ix_products_pharmacy ON products (pharmacy_id) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_products_updated BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- Dispensações ----------
CREATE TABLE dispensations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id uuid NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES pharmacy_users(id),
  client_uuid uuid NOT NULL,                       -- idempotência (reenvios offline)
  total       numeric(14,2) NOT NULL DEFAULT 0,
  offline     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_dispensations_client UNIQUE (pharmacy_id, client_uuid)
);
CREATE INDEX ix_dispensations_pharmacy_date ON dispensations (pharmacy_id, created_at DESC);

CREATE TABLE dispensation_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispensation_id uuid NOT NULL REFERENCES dispensations(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES products(id),
  quantity        integer NOT NULL CHECK (quantity > 0),
  unit_price      numeric(14,2) NOT NULL
);
CREATE INDEX ix_disp_items_dispensation ON dispensation_items (dispensation_id);
CREATE INDEX ix_disp_items_product ON dispensation_items (product_id);

-- ---------- Inventários ----------
CREATE TABLE inventories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id   uuid NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  title         varchar(120) NOT NULL,
  status        inventory_status NOT NULL DEFAULT 'AGENDADO',
  scheduled_for date NOT NULL,
  created_by    uuid REFERENCES pharmacy_users(id),
  started_at    timestamptz,
  finished_at   timestamptz,
  closed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_inventories_pharmacy ON inventories (pharmacy_id, created_at DESC);

CREATE TABLE inventory_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id   uuid NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
  product_id     uuid NOT NULL REFERENCES products(id),
  theoretical_qty integer NOT NULL,                -- fotografia do stock no início
  counted_qty    integer CHECK (counted_qty >= 0),
  counted_by     uuid REFERENCES pharmacy_users(id),
  counted_at     timestamptz,
  status         inventory_item_status NOT NULL DEFAULT 'PENDENTE',
  CONSTRAINT ux_inventory_items UNIQUE (inventory_id, product_id)
);

-- ---------- Movimentos de stock (auditoria) ----------
CREATE TABLE stock_movements (
  id              bigserial PRIMARY KEY,
  pharmacy_id     uuid NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES products(id),
  type            movement_type NOT NULL,
  quantity        integer NOT NULL,                -- com sinal: entradas +, saídas -
  balance_after   integer NOT NULL,
  reason          text,
  user_id         uuid REFERENCES pharmacy_users(id),
  dispensation_id uuid REFERENCES dispensations(id),
  inventory_id    uuid REFERENCES inventories(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_movements_pharmacy_date ON stock_movements (pharmacy_id, created_at DESC);
CREATE INDEX ix_movements_product ON stock_movements (product_id, created_at DESC);
