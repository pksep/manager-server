import {
  DataTypes,
  type Model,
  type ModelStatic,
  type Sequelize,
  type Optional,
} from 'sequelize';
import type { Contacts, WidgetConfig } from './contracts';

interface CustomerAttributes {
  id: string;
  name: string;
  contacts: Contacts;
  erp_contact_id: string | null;
  merged_into: string | null;
  created_at: Date;
}

export interface GuestAttributes {
  id: string;
  visitor_id: string | null;
  token_hash: string;
  site_id: string;
  origin: string;
  source: Record<string, unknown>;
  expires_at: Date;
  inquiry_id: string | null;
  created_at: Date;
}

interface SiteAttributes {
  id: string;
  name: string;
  origins: string[];
  widget_origins: string[];
  config: WidgetConfig;
  enabled: boolean;
}

type CustomerModel = Model<
  CustomerAttributes,
  Optional<CustomerAttributes, 'created_at' | 'erp_contact_id' | 'merged_into'>
>;
type GuestModel = Model<
  GuestAttributes,
  Optional<GuestAttributes, 'created_at' | 'inquiry_id' | 'visitor_id'>
>;

/** Модели работают с существующей схемой; sync/alter не используются. */
export function defineModels(sequelize: Sequelize): {
  Customer: ModelStatic<CustomerModel>;
  GuestSession: ModelStatic<GuestModel>;
  Site: ModelStatic<Model<SiteAttributes>>;
} {
  const Customer = sequelize.define<CustomerModel>(
    'Customer',
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      name: { type: DataTypes.TEXT, allowNull: false },
      contacts: { type: DataTypes.JSONB, allowNull: false },
      erp_contact_id: { type: DataTypes.TEXT, allowNull: true },
      merged_into: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    },
    { tableName: 'customers', timestamps: false },
  );
  const GuestSession = sequelize.define<GuestModel>(
    'GuestSession',
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      visitor_id: { type: DataTypes.UUID, allowNull: true },
      token_hash: { type: DataTypes.TEXT, allowNull: false },
      site_id: { type: DataTypes.TEXT, allowNull: false },
      origin: { type: DataTypes.TEXT, allowNull: false },
      source: { type: DataTypes.JSONB, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      inquiry_id: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    },
    { tableName: 'guest_sessions', timestamps: false },
  );
  const Site = sequelize.define<Model<SiteAttributes>>(
    'Site',
    {
      id: { type: DataTypes.TEXT, primaryKey: true },
      name: { type: DataTypes.TEXT, allowNull: false },
      origins: { type: DataTypes.JSONB, allowNull: false },
      widget_origins: { type: DataTypes.JSONB, allowNull: false },
      config: { type: DataTypes.JSONB, allowNull: false },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false },
    },
    { tableName: 'sites', timestamps: false },
  );
  return { Customer, GuestSession, Site };
}
