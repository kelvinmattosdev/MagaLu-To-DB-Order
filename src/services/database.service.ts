import pg from "pg";
import crypto from "node:crypto";
import { dbMagaluConfig } from "../config/config";

const { Pool } = pg;

export const poolMagalu = new Pool({
    connectionString: dbMagaluConfig.url,
});

const MAGALU_SCHEMA = (dbMagaluConfig as any).schema ?? "magazine_luiza";

/**
 * Persiste automaticamente QUALQUER payload Magalu:
 * - Detalhe do pedido (objeto único ou array de pedidos)
 * - Listagem com { meta, results } (orders ou deliveries)
 *
 * Você pode passar o payload "inteiro" (raw) sem mapear nada.
 */
export async function persistMagaluApiResponse(payload: any, opts?: { company?: string }): Promise<void> {
    const bundles = normalizePayloadToBundles(payload, opts?.company);

    for (const b of bundles) {
        await withTransaction(async (client) => {
            // 1) seller refs
            for (const s of b.sellers) {
                await upsertSeller(client, s);
            }

            // 2) order (com reconciliação se existir conflito order_code x order_id)
            await upsertOrderWithCodeReconciliation(client, b.order);

            // 3) payments (replace)
            await replaceOrderPayments(client, b.order.order_id, b.payments);

            // 4) deliveries + items + returns
            for (const d of b.deliveries) {
                await upsertDelivery(client, d.delivery);

                for (const it of d.items) {
                    await upsertDeliveryItem(client, it);
                }

                await replaceDeliveryReturns(client, d.delivery.delivery_id, d.returns);
            }
        });
    }
}

/* =======================================================================================
 * Normalização de payload (aceita payload cru e gera "bundles" prontos pro DB)
 * ======================================================================================= */

type SellerUpsert = {
    seller_id: string;
    seller_name: string;
    alias?: string | null;
    marketplace_document?: string | null;
};

type OrderUpsert = {
    order_id: string; // uuid (real ou sintético)
    order_code: string;
    status: string;

    created_at?: string | null;
    purchased_at?: string | null;
    approved_at?: string | null;
    updated_at: string;

    channel_id?: string | null;
    channel_alias?: string | null;
    marketplace_document?: string | null;

    customer_name?: string | null;
    customer_type?: string | null;
    customer_document?: string | null;
    customer_birth_date?: string | null;

    currency?: string | null;
    normalizer?: number | null;

    amount_total?: number | null;
    amount_discount_total?: number | null;
    amount_freight_total?: number | null;
    amount_tax_total?: number | null;
    amount_commission_total?: number | null;

    raw_json: any;
};

type OrderPaymentInsert = {
    order_id: string;

    gateway_document?: string | null;
    description?: string | null;

    installments?: number | null;
    method?: string | null;
    method_brand?: string | null;
    type?: string | null;
    brand?: string | null;

    authorization_code?: string | null;
    integration_type?: string | null;

    currency?: string | null;
    normalizer?: number | null;
    amount?: number | null;

    extras?: any;
};

type DeliveryUpsert = {
    delivery_id: string;
    delivery_code: string;

    order_id: string;
    seller_id: string;

    status: string;

    purchased_at?: string | null;
    shipped_at?: string | null;
    posting_date?: string | null;

    currency?: string | null;
    normalizer?: number | null;
    amount_total?: number | null;
    amount_discount_total?: number | null;
    amount_freight_total?: number | null;
    amount_tax_total?: number | null;
    amount_commission_total?: number | null;

    tracking_url?: string | null;
    tracking_code_id?: string | null;
    tracking_json?: any;

    provider_id?: string | null;
    provider_name?: string | null;
    provider_description?: string | null;
    provider_extras?: any;

    handling_value?: number | null;
    handling_precision?: string | null;
    handling_workday?: boolean | null;
    handling_limit_date?: string | null; // YYYY-MM-DD

    deadline_value?: number | null;
    deadline_precision?: string | null;
    deadline_workday?: boolean | null;
    deadline_limit_date?: string | null; // YYYY-MM-DD

    recipient_name?: string | null;
    recipient_customer_type?: string | null;
    recipient_document?: string | null;
    recipient_zipcode?: string | null;
    recipient_street?: string | null;
    recipient_number?: string | null;
    recipient_district?: string | null;
    recipient_city?: string | null;
    recipient_state?: string | null;
    recipient_country?: string | null;
    recipient_complement?: string | null;
    recipient_reference?: string | null;

    pickup_store_document?: string | null;
    pickup_zipcode?: string | null;
    pickup_street?: string | null;
    pickup_number?: string | null;
    pickup_district?: string | null;
    pickup_city?: string | null;
    pickup_state?: string | null;
    pickup_country?: string | null;
    pickup_complement?: string | null;
    pickup_reference?: string | null;

    raw_json: any;
};

type DeliveryItemUpsert = {
    delivery_id: string;

    sequencial: number;
    sku: string;

    product_id?: string | null;
    name?: string | null;
    brand?: string | null;
    image_url?: string | null;

    measure_unit?: string | null;
    quantity?: number | null;

    currency?: string | null;
    normalizer?: number | null;

    unit_price_value?: number | null;
    item_total?: number | null;

    amounts_json?: any;
    info_json?: any;
};

type DeliveryReturnInsert = {
    delivery_id: string;

    external_id?: string | null;
    tracking_url?: string | null;
    date?: string | null;
    protocol?: string | null;
    status?: string | null;
    reason?: string | null;
    extras?: any;
};

type Bundle = {
    order: OrderUpsert;
    sellers: SellerUpsert[];
    payments: OrderPaymentInsert[];
    deliveries: Array<{
        delivery: DeliveryUpsert;
        items: DeliveryItemUpsert[];
        returns: DeliveryReturnInsert[];
    }>;
};

function normalizePayloadToBundles(payload: any, company?: string): Bundle[] {
    // Payload pode vir:
    // - { ...order }
    // - [ { ...order }, ... ]
    // - { meta, results: [...] }
    // - [ { meta, results: [...] } ] (como seu exemplo)
    const root = Array.isArray(payload) && payload.length === 1 ? payload[0] : payload;

    // Caso A: Detalhe de pedido (tem customer + deliveries)
    if (isOrderDetail(root)) {
        return [bundleFromOrderDetail(root, company)];
    }
    if (Array.isArray(root) && root.length && isOrderDetail(root[0])) {
        return root.map((o: any) => bundleFromOrderDetail(o, company));
    }

    // Caso B: Listagem { meta, results }
    if (isMetaResults(root)) {
        // Pode ser listagem de Orders (results contém deliveries[])
        if (root.results?.length && isOrderListResult(root.results[0])) {
            return root.results.map((r: any) => bundleFromOrderListResult(r, company));
        }

        // Pode ser listagem de Deliveries (results contém order + seller + shipping)
        if (root.results?.length && isDeliveryListResult(root.results[0])) {
            return bundlesFromDeliveryListResults(root.results, company);
        }
    }

    // Caso C: array com wrappers meta/results
    if (Array.isArray(payload) && payload.length && isMetaResults(payload[0])) {
        const all: Bundle[] = [];
        for (const w of payload) {
            all.push(...normalizePayloadToBundles(w, company));
        }
        return all;
    }

    // Caso D: fallback – tenta tratar como "um order"
    if (payload && typeof payload === "object" && (payload.id || payload.code)) {
        return [bundleFromOrderDetail(payload, company)];
    }

    throw new Error("Payload Magalu não reconhecido. Envie o payload bruto do endpoint (detail ou list/meta).");
}

function isMetaResults(x: any): boolean {
    return x && typeof x === "object" && "meta" in x && Array.isArray(x.results);
}

function isOrderDetail(x: any): boolean {
    // Pedido "detalhado" / "completo" geralmente tem deliveries[]
    // (customer pode não vir em alguns endpoints/listagens)
    return x && typeof x === "object" && x.id && x.code && Array.isArray(x.deliveries);
}

function isOrderListResult(x: any): boolean {
    // Listagem de pedidos pode vir sem customer, mas quase sempre tem deliveries[]
    return x && typeof x === "object" && x.id && x.code && Array.isArray(x.deliveries);
}

function isDeliveryListResult(x: any): boolean {
    // listagem de deliveries tem order{code} e seller e items e shipping
    return x && typeof x === "object" && x.id && x.code && x.seller && x.order && x.order.code;
}

function bundleFromOrderDetail(order: any, company?: string): Bundle {
    const orderAmounts = parseAmounts(order.amounts);

    const channelId = order.channel?.id ?? null;
    const channelAlias = order.channel?.extras?.alias ?? null;
    const marketplaceDocument = order.channel?.marketplace?.document ?? null;

    const customerName = order.customer?.name ?? null;
    const customerType = order.customer?.customer_type ?? null;
    const customerDocument = order.customer?.document_number ?? null;
    const customerBirthDate = order.customer?.birth_date ?? null;

    const o: OrderUpsert = {
        order_id: String(order.id),
        order_code: String(order.code),
        status: String(order.status ?? "unknown"),

        created_at: order.created_at ?? null,
        purchased_at: order.purchased_at ?? null,
        approved_at: order.approved_at ?? null,
        updated_at: order.updated_at ?? order.purchased_at ?? new Date().toISOString(),

        channel_id: channelId,
        channel_alias: channelAlias,
        marketplace_document: marketplaceDocument,

        customer_name: customerName,
        customer_type: customerType,
        customer_document: customerDocument,
        customer_birth_date: customerBirthDate,

        currency: orderAmounts.currency,
        normalizer: orderAmounts.normalizer,

        amount_total: orderAmounts.total,
        amount_discount_total: orderAmounts.discount_total,
        amount_freight_total: orderAmounts.freight_total,
        amount_tax_total: orderAmounts.tax_total,
        amount_commission_total: orderAmounts.commission_total,

        raw_json: addCompanyToRaw(order, company),
    };

    const payments: OrderPaymentInsert[] = Array.isArray(order.payments)
        ? order.payments.map((p: any) => ({
            order_id: o.order_id,
            gateway_document: p.gateway?.document ?? null,
            description: p.description ?? null,
            installments: asInt(p.installments),
            method: p.method ?? null,
            method_brand: p.method_brand ?? null,
            type: p.type ?? null,
            brand: p.brand ?? null,
            authorization_code: p.authorization_code ?? null,
            integration_type: p.integration_type ?? null,
            currency: p.currency ?? "BRL",
            normalizer: asInt(p.normalizer) ?? 100,
            amount: asInt(p.amount),
            extras: p.extras ?? {},
        }))
        : [];

    const sellers: SellerUpsert[] = [];
    const deliveries = (order.deliveries ?? []).map((d: any) => {
        const sellerId = d.seller?.id ? String(d.seller.id) : "unknown";
        const sellerName = d.seller?.name ? String(d.seller.name) : "unknown";

        sellers.push({
            seller_id: sellerId,
            seller_name: sellerName,
            alias: channelAlias,
            marketplace_document: marketplaceDocument,
        });

        return normalizeDeliveryBlock(d, {
            order_id: o.order_id,
            order_code: o.order_code,
            seller_id: sellerId,
            company,
        });
    });

    return {
        order: o,
        sellers: uniqSellers(sellers),
        payments,
        deliveries,
    };
}

function bundleFromOrderListResult(r: any, company?: string): Bundle {
    // Similar ao detail, mas pode vir mais “enxuto”
    return bundleFromOrderDetail(r, company);
}

function bundlesFromDeliveryListResults(results: any[], company?: string): Bundle[] {
    // Agrupa deliveries por order_code
    const map = new Map<string, any[]>();
    for (const d of results) {
        const orderCode = String(d.order?.code ?? "unknown");
        if (!map.has(orderCode)) map.set(orderCode, []);
        map.get(orderCode)!.push(d);
    }

    const bundles: Bundle[] = [];

    for (const [orderCode, deliveries] of map.entries()) {
        // order_id pode não existir nesse endpoint -> gera determinístico (seller_id + orderCode)
        const anySellerId = String(deliveries[0]?.seller?.id ?? "unknown");
        const syntheticOrderId = deterministicUuid(`magalu:${anySellerId}:${orderCode}`);

        const channelId = deliveries[0]?.order?.channel?.id ?? null;
        const channelAlias = deliveries[0]?.order?.channel?.extras?.alias ?? null;
        const marketplaceDocument = deliveries[0]?.order?.channel?.marketplace?.document ?? null;

        const purchasedAt = deliveries[0]?.purchased_at ?? null;

        const o: OrderUpsert = {
            order_id: syntheticOrderId,
            order_code: orderCode,
            status: "unknown",
            created_at: null,
            purchased_at: purchasedAt,
            approved_at: null,
            updated_at: purchasedAt ?? new Date().toISOString(),

            channel_id: channelId,
            channel_alias: channelAlias,
            marketplace_document: marketplaceDocument,

            customer_name: deliveries[0]?.shipping?.recipient?.name ?? null,
            customer_type: deliveries[0]?.shipping?.recipient?.customer_type ?? null,
            customer_document: deliveries[0]?.shipping?.recipient?.document_number ?? null,
            customer_birth_date: null,

            currency: "BRL",
            normalizer: 100,

            amount_total: null,
            amount_discount_total: null,
            amount_freight_total: null,
            amount_tax_total: null,
            amount_commission_total: null,

            raw_json: addCompanyToRaw(
                { meta: { synthetic: true }, deliveries: deliveries, order: deliveries[0]?.order },
                company
            ),
        };

        const sellers: SellerUpsert[] = deliveries.map((d: any) => ({
            seller_id: String(d.seller?.id ?? "unknown"),
            seller_name: String(d.seller?.name ?? "unknown"),
            alias: channelAlias,
            marketplace_document: marketplaceDocument,
        }));

        const deliveryBlocks = deliveries.map((d: any) =>
            normalizeDeliveryBlock(d, {
                order_id: o.order_id,
                order_code: o.order_code,
                seller_id: String(d.seller?.id ?? "unknown"),
                company,
            })
        );

        bundles.push({
            order: o,
            sellers: uniqSellers(sellers),
            payments: [],
            deliveries: deliveryBlocks,
        });
    }

    return bundles;
}

function normalizeDeliveryBlock(
    d: any,
    ctx: { order_id: string; order_code: string; seller_id: string; company?: string }
): { delivery: DeliveryUpsert; items: DeliveryItemUpsert[]; returns: DeliveryReturnInsert[] } {
    const amounts = parseAmounts(d.amounts);

    const shipping = d.shipping ?? {};
    const provider = shipping.provider ?? {};
    const providerExtras = provider.extras ?? {};

    const trackingUrl = shipping.tracking_url ?? shipping.tracking?.url ?? null;

    const recipient = shipping.recipient ?? {};
    const rAddr = recipient.address ?? {};

    const pickup = shipping.pickup_details ?? {};
    const pAddr = pickup.address ?? {};
    const pStore = pickup.store ?? {};

    const delivery: DeliveryUpsert = {
        delivery_id: String(d.id),
        delivery_code: String(d.code),

        order_id: ctx.order_id,
        seller_id: ctx.seller_id,

        status: String(d.status ?? "unknown"),

        purchased_at: d.purchased_at ?? null,
        shipped_at: shipping.shipped_at ?? null,
        posting_date: shipping.posting_date ?? null,

        currency: amounts.currency ?? "BRL",
        normalizer: amounts.normalizer ?? 100,
        amount_total: amounts.total,
        amount_discount_total: amounts.discount_total,
        amount_freight_total: amounts.freight_total,
        amount_tax_total: amounts.tax_total,
        amount_commission_total: amounts.commission_total,

        tracking_url: trackingUrl,
        tracking_code_id: extractTrackingCodeId(trackingUrl),
        tracking_json: shipping.tracking ?? {},

        provider_id: provider.id ?? null,
        provider_name: provider.name ?? null,
        provider_description: provider.description ?? null,
        provider_extras: providerExtras,

        handling_value: asInt(shipping.handling_time?.value),
        handling_precision: shipping.handling_time?.precision ?? null,
        handling_workday: asBool(shipping.handling_time?.workday),
        handling_limit_date: shipping.handling_time?.limit_date ?? null,

        deadline_value: asInt(shipping.deadline?.value),
        deadline_precision: shipping.deadline?.precision ?? null,
        deadline_workday: asBool(shipping.deadline?.workday),
        deadline_limit_date: shipping.deadline?.limit_date ?? null,

        recipient_name: recipient.name ?? null,
        recipient_customer_type: recipient.customer_type ?? null,
        recipient_document: recipient.document_number ?? null,
        recipient_zipcode: rAddr.zipcode ?? null,
        recipient_street: rAddr.street ?? null,
        recipient_number: rAddr.number ?? null,
        recipient_district: rAddr.district ?? null,
        recipient_city: rAddr.city ?? null,
        recipient_state: rAddr.state ?? null,
        recipient_country: rAddr.country ?? null,
        recipient_complement: rAddr.complement ?? null,
        recipient_reference: rAddr.reference ?? null,

        pickup_store_document: pStore.document ?? null,
        pickup_zipcode: pAddr.zipcode ?? null,
        pickup_street: pAddr.street ?? null,
        pickup_number: pAddr.number ?? null,
        pickup_district: pAddr.district ?? null,
        pickup_city: pAddr.city ?? null,
        pickup_state: pAddr.state ?? null,
        pickup_country: pAddr.country ?? null,
        pickup_complement: pAddr.complement ?? null,
        pickup_reference: pAddr.reference ?? null,

        raw_json: addCompanyToRaw(d, ctx.company),
    };

    const items: DeliveryItemUpsert[] = Array.isArray(d.items)
        ? d.items.map((it: any, idx: number) => {
            const info = it.info ?? {};
            const images = Array.isArray(info.images) ? info.images : [];
            const firstImage = images[0]?.url ?? null;

            const seq = asInt(it.sequencial) ?? (idx + 1);

            return {
                delivery_id: delivery.delivery_id,
                sequencial: seq,
                sku: String(info.sku ?? "UNKNOWN"),

                product_id: info.id ?? null,
                name: info.name ?? null,
                brand: info.brand ?? null,
                image_url: firstImage,

                measure_unit: it.measure_unit ?? null,
                quantity: asInt(it.quantity) ?? 1,

                currency: it.unit_price?.currency ?? amounts.currency ?? "BRL",
                normalizer: asInt(it.unit_price?.normalizer) ?? amounts.normalizer ?? 100,

                unit_price_value: asInt(it.unit_price?.value),
                item_total: asInt(it.amounts?.total),

                amounts_json: it.amounts ?? {},
                info_json: info ?? {},
            };
        })
        : [];

    const returns: DeliveryReturnInsert[] = Array.isArray(d.returns)
        ? d.returns.map((r: any) => ({
            delivery_id: delivery.delivery_id,
            external_id: r.external_id ?? null,
            tracking_url: r.tracking_url ?? null,
            date: r.date ?? null,
            protocol: r.protocol ?? null,
            status: r.status ?? null,
            reason: r.reason ?? null,
            extras: r.extras ?? {},
        }))
        : [];

    return { delivery, items, returns };
}

function uniqSellers(sellers: SellerUpsert[]): SellerUpsert[] {
    const map = new Map<string, SellerUpsert>();
    for (const s of sellers) {
        if (!s?.seller_id) continue;
        if (!map.has(s.seller_id)) map.set(s.seller_id, s);
    }
    return [...map.values()];
}

function addCompanyToRaw(raw: any, company?: string) {
    if (!company) return raw;
    return { ...raw, _company: company };
}

/* =======================================================================================
 * DB Helpers (transaction + upserts)
 * ======================================================================================= */

async function withTransaction<T>(fn: (client: any) => Promise<T>): Promise<T> {
    const client = await poolMagalu.connect();
    try {
        await client.query("BEGIN");
        const res = await fn(client);
        await client.query("COMMIT");
        return res;
    } catch (e) {
        await client.query("ROLLBACK");
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Resolve conflito quando já existe um order com mesmo order_code mas order_id diferente.
 * Estratégia segura:
 * 1) renomeia temporariamente o order_code antigo (libera o UNIQUE)
 * 2) insere o novo order_id com o order_code correto
 * 3) migra deliveries/payments pro novo order_id
 * 4) remove o antigo
 */
async function upsertOrderWithCodeReconciliation(client: any, order: OrderUpsert): Promise<void> {
    const existing = await client.query(
        `SELECT order_id FROM ${MAGALU_SCHEMA}.orders WHERE order_code = $1 LIMIT 1`,
        [order.order_code]
    );

    const existingOrderId: string | undefined = existing.rows?.[0]?.order_id;

    if (existingOrderId && existingOrderId !== order.order_id) {
        // 1) Renomeia o código antigo pra liberar o UNIQUE(order_code)
        const tempCode = `${order.order_code}__old__${Date.now()}__${String(existingOrderId).slice(0, 8)}`;
        await client.query(
            `UPDATE ${MAGALU_SCHEMA}.orders SET order_code = $1 WHERE order_id = $2`,
            [tempCode, existingOrderId]
        );

        // 2) Upsert do novo
        await upsertOrder(client, order);

        // 3) Migra FKs
        await client.query(
            `UPDATE ${MAGALU_SCHEMA}.deliveries SET order_id = $1 WHERE order_id = $2`,
            [order.order_id, existingOrderId]
        );
        await client.query(
            `UPDATE ${MAGALU_SCHEMA}.order_payments SET order_id = $1 WHERE order_id = $2`,
            [order.order_id, existingOrderId]
        );

        // 4) Remove o antigo
        await client.query(
            `DELETE FROM ${MAGALU_SCHEMA}.orders WHERE order_id = $1`,
            [existingOrderId]
        );

        return;
    }

    await upsertOrder(client, order);
}

async function upsertSeller(client: any, seller: SellerUpsert): Promise<void> {
    await client.query(
        `
        INSERT INTO ${MAGALU_SCHEMA}.sellers
          (seller_id, seller_name, alias, marketplace_document, created_at, updated_at)
        VALUES
          ($1, $2, $3, $4, now(), now())
        ON CONFLICT (seller_id) DO UPDATE SET
          seller_name = EXCLUDED.seller_name,
          alias = COALESCE(EXCLUDED.alias, ${MAGALU_SCHEMA}.sellers.alias),
          marketplace_document = COALESCE(EXCLUDED.marketplace_document, ${MAGALU_SCHEMA}.sellers.marketplace_document),
          updated_at = now()
        `,
        [seller.seller_id, seller.seller_name, seller.alias ?? null, seller.marketplace_document ?? null]
    );
}

async function upsertOrder(client: any, o: OrderUpsert): Promise<void> {
    await client.query(
        `
        INSERT INTO ${MAGALU_SCHEMA}.orders
        (
          order_id, order_code, status,
          created_at, purchased_at, approved_at, updated_at,
          channel_id, channel_alias, marketplace_document,
          customer_name, customer_type, customer_document, customer_birth_date,
          currency, normalizer,
          amount_total, amount_discount_total, amount_freight_total, amount_tax_total, amount_commission_total,
          raw_json, inserted_at
        )
        VALUES
        (
          $1, $2, $3,
          $4, $5, $6, $7,
          $8, $9, $10,
          $11, $12, $13, $14,
          $15, $16,
          $17, $18, $19, $20, $21,
          $22::jsonb, now()
        )
        ON CONFLICT (order_id) DO UPDATE SET
          order_code = EXCLUDED.order_code,
          status = EXCLUDED.status,
          created_at = COALESCE(EXCLUDED.created_at, ${MAGALU_SCHEMA}.orders.created_at),
          purchased_at = COALESCE(EXCLUDED.purchased_at, ${MAGALU_SCHEMA}.orders.purchased_at),
          approved_at = COALESCE(EXCLUDED.approved_at, ${MAGALU_SCHEMA}.orders.approved_at),
          updated_at = EXCLUDED.updated_at,
          channel_id = COALESCE(EXCLUDED.channel_id, ${MAGALU_SCHEMA}.orders.channel_id),
          channel_alias = COALESCE(EXCLUDED.channel_alias, ${MAGALU_SCHEMA}.orders.channel_alias),
          marketplace_document = COALESCE(EXCLUDED.marketplace_document, ${MAGALU_SCHEMA}.orders.marketplace_document),
          customer_name = COALESCE(EXCLUDED.customer_name, ${MAGALU_SCHEMA}.orders.customer_name),
          customer_type = COALESCE(EXCLUDED.customer_type, ${MAGALU_SCHEMA}.orders.customer_type),
          customer_document = COALESCE(EXCLUDED.customer_document, ${MAGALU_SCHEMA}.orders.customer_document),
          customer_birth_date = COALESCE(EXCLUDED.customer_birth_date, ${MAGALU_SCHEMA}.orders.customer_birth_date),
          currency = COALESCE(EXCLUDED.currency, ${MAGALU_SCHEMA}.orders.currency),
          normalizer = COALESCE(EXCLUDED.normalizer, ${MAGALU_SCHEMA}.orders.normalizer),
          amount_total = COALESCE(EXCLUDED.amount_total, ${MAGALU_SCHEMA}.orders.amount_total),
          amount_discount_total = COALESCE(EXCLUDED.amount_discount_total, ${MAGALU_SCHEMA}.orders.amount_discount_total),
          amount_freight_total = COALESCE(EXCLUDED.amount_freight_total, ${MAGALU_SCHEMA}.orders.amount_freight_total),
          amount_tax_total = COALESCE(EXCLUDED.amount_tax_total, ${MAGALU_SCHEMA}.orders.amount_tax_total),
          amount_commission_total = COALESCE(EXCLUDED.amount_commission_total, ${MAGALU_SCHEMA}.orders.amount_commission_total),
          raw_json = EXCLUDED.raw_json
        `,
        [
            o.order_id,
            o.order_code,
            o.status,
            toDateOrNull(o.created_at),
            toDateOrNull(o.purchased_at),
            toDateOrNull(o.approved_at),
            toDateOrNull(o.updated_at),

            o.channel_id ?? null,
            o.channel_alias ?? null,
            o.marketplace_document ?? null,

            o.customer_name ?? null,
            o.customer_type ?? null,
            o.customer_document ?? null,
            o.customer_birth_date ?? null,

            o.currency ?? "BRL",
            o.normalizer ?? 100,

            o.amount_total ?? null,
            o.amount_discount_total ?? null,
            o.amount_freight_total ?? null,
            o.amount_tax_total ?? null,
            o.amount_commission_total ?? null,

            JSON.stringify(o.raw_json ?? {}),
        ]
    );
}

async function replaceOrderPayments(client: any, orderId: string, payments: OrderPaymentInsert[]): Promise<void> {
    await client.query(`DELETE FROM ${MAGALU_SCHEMA}.order_payments WHERE order_id = $1`, [orderId]);

    if (!payments.length) return;

    for (const p of payments) {
        await client.query(
            `
            INSERT INTO ${MAGALU_SCHEMA}.order_payments
            (
              order_id, gateway_document, description,
              installments, method, method_brand, type, brand,
              authorization_code, integration_type,
              currency, normalizer, amount,
              extras, inserted_at
            )
            VALUES
            (
              $1,$2,$3,
              $4,$5,$6,$7,$8,
              $9,$10,
              $11,$12,$13,
              $14::jsonb, now()
            )
            `,
            [
                p.order_id,
                p.gateway_document ?? null,
                p.description ?? null,
                p.installments ?? null,
                p.method ?? null,
                p.method_brand ?? null,
                p.type ?? null,
                p.brand ?? null,
                p.authorization_code ?? null,
                p.integration_type ?? null,
                p.currency ?? "BRL",
                p.normalizer ?? 100,
                p.amount ?? null,
                JSON.stringify(p.extras ?? {}),
            ]
        );
    }
}

async function upsertDelivery(client: any, d: DeliveryUpsert): Promise<void> {
    await client.query(
        `
        INSERT INTO ${MAGALU_SCHEMA}.deliveries
        (
          delivery_id, delivery_code, order_id, seller_id, status,
          purchased_at, shipped_at, posting_date,
          currency, normalizer,
          amount_total, amount_discount_total, amount_freight_total, amount_tax_total, amount_commission_total,
          tracking_url, tracking_code_id, tracking_json,
          provider_id, provider_name, provider_description, provider_extras,
          handling_value, handling_precision, handling_workday, handling_limit_date,
          deadline_value, deadline_precision, deadline_workday, deadline_limit_date,
          recipient_name, recipient_customer_type, recipient_document,
          recipient_zipcode, recipient_street, recipient_number, recipient_district, recipient_city, recipient_state, recipient_country,
          recipient_complement, recipient_reference,
          pickup_store_document,
          pickup_zipcode, pickup_street, pickup_number, pickup_district, pickup_city, pickup_state, pickup_country,
          pickup_complement, pickup_reference,
          raw_json, inserted_at
        )
        VALUES
        (
          $1,$2,$3,$4,$5,
          $6,$7,$8,
          $9,$10,
          $11,$12,$13,$14,$15,
          $16,$17,$18::jsonb,
          $19,$20,$21,$22::jsonb,
          $23,$24,$25,$26,
          $27,$28,$29,$30,
          $31,$32,$33,
          $34,$35,$36,$37,$38,$39,$40,
          $41,$42,
          $43,
          $44,$45,$46,$47,$48,$49,$50,
          $51,$52,
          $53::jsonb, now()
        )
        ON CONFLICT (delivery_id) DO UPDATE SET
          delivery_code = EXCLUDED.delivery_code,
          order_id = EXCLUDED.order_id,
          seller_id = EXCLUDED.seller_id,
          status = EXCLUDED.status,
          purchased_at = COALESCE(EXCLUDED.purchased_at, ${MAGALU_SCHEMA}.deliveries.purchased_at),
          shipped_at = COALESCE(EXCLUDED.shipped_at, ${MAGALU_SCHEMA}.deliveries.shipped_at),
          posting_date = COALESCE(EXCLUDED.posting_date, ${MAGALU_SCHEMA}.deliveries.posting_date),

          currency = COALESCE(EXCLUDED.currency, ${MAGALU_SCHEMA}.deliveries.currency),
          normalizer = COALESCE(EXCLUDED.normalizer, ${MAGALU_SCHEMA}.deliveries.normalizer),

          amount_total = COALESCE(EXCLUDED.amount_total, ${MAGALU_SCHEMA}.deliveries.amount_total),
          amount_discount_total = COALESCE(EXCLUDED.amount_discount_total, ${MAGALU_SCHEMA}.deliveries.amount_discount_total),
          amount_freight_total = COALESCE(EXCLUDED.amount_freight_total, ${MAGALU_SCHEMA}.deliveries.amount_freight_total),
          amount_tax_total = COALESCE(EXCLUDED.amount_tax_total, ${MAGALU_SCHEMA}.deliveries.amount_tax_total),
          amount_commission_total = COALESCE(EXCLUDED.amount_commission_total, ${MAGALU_SCHEMA}.deliveries.amount_commission_total),

          tracking_url = COALESCE(EXCLUDED.tracking_url, ${MAGALU_SCHEMA}.deliveries.tracking_url),
          tracking_code_id = COALESCE(EXCLUDED.tracking_code_id, ${MAGALU_SCHEMA}.deliveries.tracking_code_id),
          tracking_json = COALESCE(EXCLUDED.tracking_json, ${MAGALU_SCHEMA}.deliveries.tracking_json),

          provider_id = COALESCE(EXCLUDED.provider_id, ${MAGALU_SCHEMA}.deliveries.provider_id),
          provider_name = COALESCE(EXCLUDED.provider_name, ${MAGALU_SCHEMA}.deliveries.provider_name),
          provider_description = COALESCE(EXCLUDED.provider_description, ${MAGALU_SCHEMA}.deliveries.provider_description),
          provider_extras = COALESCE(EXCLUDED.provider_extras, ${MAGALU_SCHEMA}.deliveries.provider_extras),

          handling_value = COALESCE(EXCLUDED.handling_value, ${MAGALU_SCHEMA}.deliveries.handling_value),
          handling_precision = COALESCE(EXCLUDED.handling_precision, ${MAGALU_SCHEMA}.deliveries.handling_precision),
          handling_workday = COALESCE(EXCLUDED.handling_workday, ${MAGALU_SCHEMA}.deliveries.handling_workday),
          handling_limit_date = COALESCE(EXCLUDED.handling_limit_date, ${MAGALU_SCHEMA}.deliveries.handling_limit_date),

          deadline_value = COALESCE(EXCLUDED.deadline_value, ${MAGALU_SCHEMA}.deliveries.deadline_value),
          deadline_precision = COALESCE(EXCLUDED.deadline_precision, ${MAGALU_SCHEMA}.deliveries.deadline_precision),
          deadline_workday = COALESCE(EXCLUDED.deadline_workday, ${MAGALU_SCHEMA}.deliveries.deadline_workday),
          deadline_limit_date = COALESCE(EXCLUDED.deadline_limit_date, ${MAGALU_SCHEMA}.deliveries.deadline_limit_date),

          raw_json = EXCLUDED.raw_json
        `,
        [
            d.delivery_id,
            d.delivery_code,
            d.order_id,
            d.seller_id,
            d.status,
            toDateOrNull(d.purchased_at),
            toDateOrNull(d.shipped_at),
            toDateOrNull(d.posting_date),

            d.currency ?? "BRL",
            d.normalizer ?? 100,

            d.amount_total ?? null,
            d.amount_discount_total ?? null,
            d.amount_freight_total ?? null,
            d.amount_tax_total ?? null,
            d.amount_commission_total ?? null,

            d.tracking_url ?? null,
            d.tracking_code_id ?? null,
            JSON.stringify(d.tracking_json ?? {}),

            d.provider_id ?? null,
            d.provider_name ?? null,
            d.provider_description ?? null,
            JSON.stringify(d.provider_extras ?? {}),

            d.handling_value ?? null,
            d.handling_precision ?? null,
            d.handling_workday ?? null,
            d.handling_limit_date ?? null,

            d.deadline_value ?? null,
            d.deadline_precision ?? null,
            d.deadline_workday ?? null,
            d.deadline_limit_date ?? null,

            d.recipient_name ?? null,
            d.recipient_customer_type ?? null,
            d.recipient_document ?? null,

            d.recipient_zipcode ?? null,
            d.recipient_street ?? null,
            d.recipient_number ?? null,
            d.recipient_district ?? null,
            d.recipient_city ?? null,
            d.recipient_state ?? null,
            d.recipient_country ?? null,

            d.recipient_complement ?? null,
            d.recipient_reference ?? null,

            d.pickup_store_document ?? null,

            d.pickup_zipcode ?? null,
            d.pickup_street ?? null,
            d.pickup_number ?? null,
            d.pickup_district ?? null,
            d.pickup_city ?? null,
            d.pickup_state ?? null,
            d.pickup_country ?? null,

            d.pickup_complement ?? null,
            d.pickup_reference ?? null,

            JSON.stringify(d.raw_json ?? {}),
        ]
    );
}

async function upsertDeliveryItem(client: any, item: DeliveryItemUpsert): Promise<void> {
    await client.query(
        `
        INSERT INTO ${MAGALU_SCHEMA}.delivery_items
        (
          delivery_id, sequencial, sku,
          product_id, name, brand, image_url,
          measure_unit, quantity,
          currency, normalizer,
          unit_price_value, item_total,
          amounts_json, info_json,
          inserted_at
        )
        VALUES
        (
          $1,$2,$3,
          $4,$5,$6,$7,
          $8,$9,
          $10,$11,
          $12,$13,
          $14::jsonb,$15::jsonb,
          now()
        )
        ON CONFLICT (delivery_id, sequencial) DO UPDATE SET
          sku = EXCLUDED.sku,
          product_id = COALESCE(EXCLUDED.product_id, ${MAGALU_SCHEMA}.delivery_items.product_id),
          name = COALESCE(EXCLUDED.name, ${MAGALU_SCHEMA}.delivery_items.name),
          brand = COALESCE(EXCLUDED.brand, ${MAGALU_SCHEMA}.delivery_items.brand),
          image_url = COALESCE(EXCLUDED.image_url, ${MAGALU_SCHEMA}.delivery_items.image_url),
          measure_unit = COALESCE(EXCLUDED.measure_unit, ${MAGALU_SCHEMA}.delivery_items.measure_unit),
          quantity = COALESCE(EXCLUDED.quantity, ${MAGALU_SCHEMA}.delivery_items.quantity),
          currency = COALESCE(EXCLUDED.currency, ${MAGALU_SCHEMA}.delivery_items.currency),
          normalizer = COALESCE(EXCLUDED.normalizer, ${MAGALU_SCHEMA}.delivery_items.normalizer),
          unit_price_value = COALESCE(EXCLUDED.unit_price_value, ${MAGALU_SCHEMA}.delivery_items.unit_price_value),
          item_total = COALESCE(EXCLUDED.item_total, ${MAGALU_SCHEMA}.delivery_items.item_total),
          amounts_json = COALESCE(EXCLUDED.amounts_json, ${MAGALU_SCHEMA}.delivery_items.amounts_json),
          info_json = COALESCE(EXCLUDED.info_json, ${MAGALU_SCHEMA}.delivery_items.info_json)
        `,
        [
            item.delivery_id,
            item.sequencial,
            item.sku,
            item.product_id ?? null,
            item.name ?? null,
            item.brand ?? null,
            item.image_url ?? null,
            item.measure_unit ?? null,
            item.quantity ?? 1,
            item.currency ?? "BRL",
            item.normalizer ?? 100,
            item.unit_price_value ?? null,
            item.item_total ?? null,
            JSON.stringify(item.amounts_json ?? {}),
            JSON.stringify(item.info_json ?? {}),
        ]
    );
}

async function replaceDeliveryReturns(client: any, deliveryId: string, returnsArr: DeliveryReturnInsert[]): Promise<void> {
    await client.query(`DELETE FROM ${MAGALU_SCHEMA}.delivery_returns WHERE delivery_id = $1`, [deliveryId]);

    if (!returnsArr.length) return;

    for (const r of returnsArr) {
        await client.query(
            `
            INSERT INTO ${MAGALU_SCHEMA}.delivery_returns
            (
              delivery_id, external_id, tracking_url, date,
              protocol, status, reason, extras, inserted_at
            )
            VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, now())
            `,
            [
                r.delivery_id,
                r.external_id ?? null,
                r.tracking_url ?? null,
                toDateOrNull(r.date),
                r.protocol ?? null,
                r.status ?? null,
                r.reason ?? null,
                JSON.stringify(r.extras ?? {}),
            ]
        );
    }
}

/* =======================================================================================
 * Utils
 * ======================================================================================= */

function parseAmounts(amounts: any): {
    currency: string | null;
    normalizer: number | null;
    total: number | null;
    discount_total: number | null;
    freight_total: number | null;
    tax_total: number | null;
    commission_total: number | null;
} {
    if (!amounts || typeof amounts !== "object") {
        return {
            currency: "BRL",
            normalizer: 100,
            total: null,
            discount_total: null,
            freight_total: null,
            tax_total: null,
            commission_total: null,
        };
    }

    return {
        currency: amounts.currency ?? "BRL",
        normalizer: asInt(amounts.normalizer) ?? 100,
        total: asInt(amounts.total),
        discount_total: asInt(amounts.discount?.total),
        freight_total: asInt(amounts.freight?.total),
        tax_total: asInt(amounts.tax?.total),
        commission_total: asInt(amounts.commission?.total),
    };
}

function extractTrackingCodeId(trackingUrl?: string | null): string | null {
    if (!trackingUrl) return null;
    try {
        const u = new URL(trackingUrl);
        return u.searchParams.get("code_id");
    } catch {
        const m = String(trackingUrl).match(/code_id=([^&]+)/i);
        return m?.[1] ?? null;
    }
}

function toDateOrNull(iso?: string | null): Date | null {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
}

function asInt(v: any): number | null {
    if (v === undefined || v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
}

function asBool(v: any): boolean | null {
    if (v === undefined || v === null) return null;
    if (typeof v === "boolean") return v;
    if (v === "true") return true;
    if (v === "false") return false;
    return null;
}

/**
 * UUID determinístico (estável) a partir de uma string.
 * Usado quando o endpoint não fornece UUID do pedido.
 */
function deterministicUuid(input: string): string {
    // SHA-1 (20 bytes)
    const hash = crypto.createHash("sha1").update(input).digest();

    // Pega 16 bytes
    const b = Buffer.from(hash.subarray(0, 16));

    // Ajusta bits para versão 5 (0101) e variante RFC 4122
    b[6] = ((b[6] ?? 0) & 0x0f) | 0x50;
    b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;

    const hex = b.toString("hex");
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20),
    ].join("-");
}
