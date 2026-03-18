import { useEffect, useMemo, useState } from "react";
import { Form, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate, unauthenticated } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const searchQuery = (url.searchParams.get("q") || "").trim();

  const productsResponse = await admin.graphql(
    `#graphql
      query SearchProducts($searchQuery: String) {
        products(first: 25, query: $searchQuery, sortKey: TITLE) {
          nodes {
            id
            title
            status
            vendor
            productType
          }
        }
      }`,
    {
      variables: {
        searchQuery: searchQuery || null,
      },
    },
  );
  const productsJson = await productsResponse.json();
  const products = productsJson.data?.products?.nodes ?? [];

  const connectedStoreSessions = await db.session.findMany({
    where: {
      isOnline: false,
      shop: { not: session.shop },
    },
    select: {
      shop: true,
    },
    orderBy: {
      shop: "asc",
    },
  });

  return {
    currentShop: session.shop,
    searchQuery,
    products,
    connectedStores: connectedStoreSessions.map((record) => record.shop),
  };
};

export const action = async ({ request }) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "connect-store") {
    const targetShop = String(formData.get("targetShop") || "")
      .trim()
      .toLowerCase();
    const isValidShopDomain = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(
      targetShop,
    );

    if (!isValidShopDomain) {
      return {
        ok: false,
        message: "Enter a valid shop domain (example.myshopify.com).",
      };
    }

    if (targetShop === session.shop) {
      return {
        ok: false,
        message: "The source and target stores must be different.",
      };
    }

    return redirect(`/auth/login?shop=${encodeURIComponent(targetShop)}`);
  }

  if (intent === "sync-product") {
    const productId = String(formData.get("productId") || "").trim();
    const targetShop = String(formData.get("targetShop") || "")
      .trim()
      .toLowerCase();

    if (!productId || !targetShop) {
      return {
        ok: false,
        message: "Pick a target store and product before syncing.",
      };
    }

    const targetSession = await db.session.findFirst({
      where: {
        shop: targetShop,
        isOnline: false,
      },
      select: {
        shop: true,
      },
    });

    if (!targetSession) {
      return {
        ok: false,
        message: `No saved OAuth session for ${targetShop}. Connect it first.`,
      };
    }

    const sourceProductResponse = await admin.graphql(
      `#graphql
        query SourceProduct($id: ID!) {
          product(id: $id) {
            id
            title
            descriptionHtml
            vendor
            productType
            tags
          }
        }`,
      {
        variables: {
          id: productId,
        },
      },
    );
    const sourceProductJson = await sourceProductResponse.json();
    const sourceProduct = sourceProductJson.data?.product;

    if (!sourceProduct) {
      return {
        ok: false,
        message: "Could not load that source product.",
      };
    }

    const { admin: targetAdmin } = await unauthenticated.admin(targetShop);
    const createProductResponse = await targetAdmin.graphql(
      `#graphql
        mutation SyncProduct($product: ProductCreateInput!) {
          productCreate(product: $product) {
            product {
              id
              title
              status
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          product: {
            title: sourceProduct.title,
            descriptionHtml: sourceProduct.descriptionHtml,
            vendor: sourceProduct.vendor,
            productType: sourceProduct.productType,
            tags: sourceProduct.tags,
          },
        },
      },
    );
    const createProductJson = await createProductResponse.json();
    const userErrors = createProductJson.data?.productCreate?.userErrors ?? [];

    if (userErrors.length > 0) {
      return {
        ok: false,
        message: `Sync failed: ${userErrors[0].message}`,
      };
    }

    const syncedProduct = createProductJson.data?.productCreate?.product;

    return {
      ok: true,
      message: `Synced "${sourceProduct.title}" to ${targetShop}.`,
      syncedProduct,
    };
  }

  return {
    ok: false,
    message: "Unknown action.",
  };
};

export default function Index() {
  const { currentShop, searchQuery, products, connectedStores } = useLoaderData();
  const syncFetcher = useFetcher();
  const shopify = useAppBridge();
  const [targetShop, setTargetShop] = useState(connectedStores[0] || "");
  const isSyncing = syncFetcher.state !== "idle";
  const hasConnectedStores = connectedStores.length > 0;

  useEffect(() => {
    if (!targetShop && connectedStores.length > 0) {
      setTargetShop(connectedStores[0]);
    }
  }, [connectedStores, targetShop]);

  useEffect(() => {
    if (syncFetcher.data?.message) {
      shopify.toast.show(syncFetcher.data.message);
    }
  }, [shopify, syncFetcher.data?.message]);

  const emptySearchState = useMemo(() => {
    if (products.length > 0) {
      return null;
    }

    if (searchQuery) {
      return `No products found for "${searchQuery}".`;
    }

    return "No products found on this store yet.";
  }, [products, searchQuery]);

  return (
    <s-page heading="Store sync">
      <s-section heading="Connected stores">
        <s-paragraph>
          Source store: <s-text>{currentShop}</s-text>
        </s-paragraph>
        <form method="get" action="/auth/login" target="_top">
          <s-stack direction="inline" gap="base">
            <s-text-field
              name="shop"
              label="Connect another store"
              details="example.myshopify.com"
            ></s-text-field>
            <s-button type="submit">Connect with OAuth</s-button>
          </s-stack>
        </form>
        {hasConnectedStores ? (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text>Saved OAuth stores:</s-text>
            <s-unordered-list>
              {connectedStores.map((shopDomain) => (
                <s-list-item key={shopDomain}>{shopDomain}</s-list-item>
              ))}
            </s-unordered-list>
          </s-box>
        ) : (
          <s-paragraph>No target stores connected yet.</s-paragraph>
        )}
      </s-section>

      <s-section heading="Search products in this store">
        <Form method="get">
          <s-stack direction="inline" gap="base">
            <s-text-field
              name="q"
              label="Search"
              value={searchQuery}
              placeholder="Search by title, vendor, tag, or type"
            ></s-text-field>
            <s-button type="submit">Search</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Sync product to selected store">
        {hasConnectedStores && (
          <s-stack direction="inline" gap="base">
            <s-select
              label="Target store"
              value={targetShop}
              onChange={(event) => setTargetShop(event.currentTarget.value)}
            >
              {connectedStores.map((shopDomain) => (
                <option key={shopDomain} value={shopDomain}>
                  {shopDomain}
                </option>
              ))}
            </s-select>
          </s-stack>
        )}

        {emptySearchState ? (
          <s-paragraph>{emptySearchState}</s-paragraph>
        ) : (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-unordered-list>
              {products.map((product) => (
                <s-list-item key={product.id}>
                  <s-stack direction="inline" gap="base" alignItems="center">
                    <s-text>{product.title}</s-text>
                    <s-text tone="subdued">
                      {product.vendor || "Unknown vendor"}
                    </s-text>
                    <s-text tone="subdued">{product.status}</s-text>
                    <syncFetcher.Form method="post">
                      <input type="hidden" name="intent" value="sync-product" />
                      <input type="hidden" name="productId" value={product.id} />
                      <input type="hidden" name="targetShop" value={targetShop} />
                      <s-button
                        type="submit"
                        disabled={!hasConnectedStores}
                        {...(isSyncing ? { loading: true } : {})}
                      >
                        Sync
                      </s-button>
                    </syncFetcher.Form>
                  </s-stack>
                </s-list-item>
              ))}
            </s-unordered-list>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
