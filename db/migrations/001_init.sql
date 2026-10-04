-- Moyo Farmácia · Painel do dono · esquema inicial (PostgreSQL 13+)

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- Tipos ----------
CREATE TYPE pharmacy_status     AS ENUM ('ACTIVA', 'INACTIVA');
CREATE TYPE pharmacy_user_role  AS ENUM ('ROLE_GERENTE', 'ROLE_TECNICO');
CREATE TYPE payment_status      AS ENUM ('PENDENTE', 'PAGO');
CREATE TYPE payment_method      AS ENUM ('TRANSFERENCIA', 'MULTICAIXA_EXPRESS', 'NUMERARIO', 'DEPOSITO');

-- ---------- Trigger genérico de updated_at ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------- Donos / administradores da plataforma ----------
CREATE TABLE admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          varchar(120) NOT NULL,
  email         citext       NOT NULL UNIQUE,
  password_hash text         NOT NULL,
  active        boolean      NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_admins_updated BEFORE UPDATE ON admins
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- Farmácias (parent_id = filial de uma farmácia principal) ----------
CREATE TABLE pharmacies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id           uuid REFERENCES pharmacies(id) ON DELETE RESTRICT,
  name                varchar(160)   NOT NULL,
  nif                 varchar(20),
  license_number      varchar(60),
  province            varchar(60),
  municipality        varchar(80),
  address             varchar(255),
  phone               varchar(30),
  email               citext,
  monthly_fee         numeric(14,2)  NOT NULL DEFAULT 0 CHECK (monthly_fee >= 0),  -- em Kwanzas (AOA)
  status              pharmacy_status NOT NULL DEFAULT 'ACTIVA',
  deactivated_at      timestamptz,
  deactivation_reason text,
  created_at          timestamptz    NOT NULL DEFAULT now(),
  updated_at          timestamptz    NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT ck_pharmacies_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX ux_pharmacies_nif ON pharmacies (nif) WHERE nif IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_pharmacies_status ON pharmacies (status) WHERE deleted_at IS NULL;
CREATE INDEX ix_pharmacies_parent ON pharmacies (parent_id);
CREATE INDEX ix_pharmacies_created ON pharmacies (created_at DESC);
CREATE TRIGGER trg_pharmacies_updated BEFORE UPDATE ON pharmacies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- Contas de gerentes e técnicos de cada farmácia ----------
CREATE TABLE pharmacy_users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id          uuid NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  name                 varchar(120)       NOT NULL,
  email                citext             NOT NULL,
  phone                varchar(30),
  role                 pharmacy_user_role NOT NULL,
  password_hash        text               NOT NULL,
  must_change_password boolean            NOT NULL DEFAULT true,
  active               boolean            NOT NULL DEFAULT true,
  last_login_at        timestamptz,
  created_at           timestamptz        NOT NULL DEFAULT now(),
  updated_at           timestamptz        NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);
CREATE UNIQUE INDEX ux_pharmacy_users_email ON pharmacy_users (email) WHERE deleted_at IS NULL;
CREATE INDEX ix_pharmacy_users_pharmacy ON pharmacy_users (pharmacy_id) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_pharmacy_users_updated BEFORE UPDATE ON pharmacy_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- Mensalidades (uma por farmácia e por mês) ----------
CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id     uuid           NOT NULL REFERENCES pharmacies(id) ON DELETE RESTRICT,
  reference_month date           NOT NULL,                     -- sempre o dia 1 do mês
  amount          numeric(14,2)  NOT NULL CHECK (amount >= 0),
  status          payment_status NOT NULL DEFAULT 'PENDENTE',
  paid_at         timestamptz,
  method          payment_method,
  reference       varchar(80),                                 -- nº do comprovativo
  notes           text,
  registered_by   uuid REFERENCES admins(id),
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT ux_payments_pharmacy_month UNIQUE (pharmacy_id, reference_month),
  CONSTRAINT ck_payments_first_day CHECK (EXTRACT(DAY FROM reference_month) = 1),
  CONSTRAINT ck_payments_paid_consistency CHECK (
    (status = 'PAGO'     AND paid_at IS NOT NULL) OR
    (status = 'PENDENTE' AND paid_at IS NULL)
  )
);
CREATE INDEX ix_payments_month_status ON payments (reference_month, status);
CREATE TRIGGER trg_payments_updated BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- Auditoria ----------
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  admin_id   uuid REFERENCES admins(id),
  action     varchar(60) NOT NULL,
  entity     varchar(40) NOT NULL,
  entity_id  uuid,
  details    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_entity ON audit_log (entity, entity_id);
CREATE INDEX ix_audit_created ON audit_log (created_at DESC);
