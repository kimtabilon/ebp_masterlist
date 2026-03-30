export type MasterListDoc = {
    sku: string;

    dandh_count?: number;
    synnex_count?: number;
    ingram_count?: number;
    supplies_count?: number;

    dandh_price?: number;
    synnex_price?: number;
    ingram_price?: number;
    supplies_price?: number;

    dandh_response?: string | null;
    synnex_response?: string | null;
    ingram_response?: string | null;
    supplies_response?: string | null;

    priority?: string | null;

    created_at?: Date;
    updated_at?: Date;

    // allow extra fields without TS screaming
    [k: string]: any;
};