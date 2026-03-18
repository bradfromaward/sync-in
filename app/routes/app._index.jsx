import { useEffect, useMemo, useState } from "react";
import { Form, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate, unauthenticated } from "../shopify.server";

function getProductStatusChipStyle(status) {
  const normalizedStatus = String(status || "").toUpperCase();

  if (normalizedStatus === "ACTIVE") {
    return {
      backgroundColor: "#dcfce7",
      border: "1px solid #86efac",
      color: "#166534",
    };
  }

  if (normalizedStatus === "DRAFT") {
    return {
      backgroundColor: "#fef9c3",
      border: "1px solid #fde047",
      color: "#854d0e",
    };
  }

  if (normalizedStatus === "ARCHIVED") {
    return {
      backgroundColor: "#f3f4f6",
      border: "1px solid #d1d5db",
      color: "#374151",
    };
  }

  return {
    backgroundColor: "#dbeafe",
    border: "1px solid #93c5fd",
    color: "#1e3a8a",
  };
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const searchQuery = (url.searchParams.get("q") || "").trim();

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

  const connectedStores = connectedStoreSessions.map((record) => record.shop);
  const availableSourceStores = [session.shop, ...connectedStores];
  const requestedSourceShop = String(url.searchParams.get("sourceShop") || "")
    .trim()
    .toLowerCase();
  const sourceShop = availableSourceStores.includes(requestedSourceShop)
    ? requestedSourceShop
    : session.shop;

  const { admin: sourceAdmin } =
    sourceShop === session.shop
      ? { admin }
      : await unauthenticated.admin(sourceShop);
  const productsResponse = await sourceAdmin.graphql(
    `#graphql
      query SearchProducts($searchQuery: String) {
        products(first: 25, query: $searchQuery, sortKey: TITLE) {
          nodes {
            id
            title
            status
            vendor
            productType
            featuredImage {
              url
              altText
            }
            images(first: 10) {
              nodes {
                id
                url
                altText
              }
            }
            variants(first: 1) {
              nodes {
                sku
                barcode
                inventoryPolicy
              }
            }
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

  return {
    currentShop: session.shop,
    sourceShop,
    searchQuery,
    products,
    connectedStores,
    availableSourceStores,
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
    const targetShops = [
      ...new Set(
        formData
          .getAll("targetShops")
          .map((shop) => String(shop || "").trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    const sourceShop = String(formData.get("sourceShop") || "")
      .trim()
      .toLowerCase();
    const selectedFields = new Set(formData.getAll("fields").map((field) => String(field)));
    const firstImageId = String(formData.get("firstImageId") || "").trim();

    if (!productId || targetShops.length === 0 || !sourceShop) {
      return {
        ok: false,
        message: "Pick one or more target stores and a product before syncing.",
      };
    }

    if (targetShops.includes(sourceShop)) {
      return {
        ok: false,
        message: "Source and target stores must be different.",
      };
    }

    if (!selectedFields.has("title")) {
      return {
        ok: false,
        message: "Title is required when creating a synced product.",
      };
    }

    const savedSessions = await db.session.findMany({
      where: {
        isOnline: false,
      },
      select: {
        shop: true,
      },
    });
    const savedShops = new Set(savedSessions.map((record) => record.shop));

    if (sourceShop !== session.shop && !savedShops.has(sourceShop)) {
      return {
        ok: false,
        message: `No saved OAuth session for ${sourceShop}. Connect it first.`,
      };
    }

    for (const targetShop of targetShops) {
      if (targetShop !== session.shop && !savedShops.has(targetShop)) {
        return {
          ok: false,
          message: `No saved OAuth session for ${targetShop}. Connect it first.`,
        };
      }
    }

    const sourceAdmin =
      sourceShop === session.shop
        ? admin
        : (await unauthenticated.admin(sourceShop)).admin;

    const sourceProductResponse = await sourceAdmin.graphql(
      `#graphql
        query SourceProduct($id: ID!) {
          product(id: $id) {
            id
            title
            descriptionHtml
            vendor
            images(first: 10) {
              nodes {
                id
                url
                altText
              }
            }
            variants(first: 1) {
              nodes {
                sku
                barcode
                inventoryPolicy
              }
            }
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

    const sourceImages = sourceProduct.images?.nodes ?? [];
    let orderedImages = sourceImages;
    if (firstImageId && sourceImages.length > 1) {
      const firstImage = sourceImages.find((image) => image.id === firstImageId);
      if (firstImage) {
        orderedImages = [
          firstImage,
          ...sourceImages.filter((image) => image.id !== firstImage.id),
        ];
      }
    }

    const sourceVariant = sourceProduct.variants?.nodes?.[0] ?? null;
    const productInput = {
      title: sourceProduct.title,
    };
    if (selectedFields.has("description")) {
      productInput.descriptionHtml = sourceProduct.descriptionHtml;
    }
    if (selectedFields.has("vendor")) {
      productInput.vendor = sourceProduct.vendor;
    }

    const mediaInput = selectedFields.has("images")
      ? orderedImages.map((image) => ({
          mediaContentType: "IMAGE",
          originalSource: image.url,
          alt: image.altText || sourceProduct.title,
        }))
      : [];

    for (const targetShop of targetShops) {
      const targetAdmin =
        targetShop === session.shop
          ? admin
          : (await unauthenticated.admin(targetShop)).admin;
      const createProductResponse = await targetAdmin.graphql(
        `#graphql
          mutation SyncProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
            productCreate(product: $product, media: $media) {
              product {
                id
                title
                status
                variants(first: 1) {
                  nodes {
                    id
                  }
                }
              }
              userErrors {
                field
                message
              }
            }
          }`,
        {
          variables: {
            product: productInput,
            media: mediaInput.length > 0 ? mediaInput : null,
          },
        },
      );
      const createProductJson = await createProductResponse.json();
      const userErrors = createProductJson.data?.productCreate?.userErrors ?? [];

      if (userErrors.length > 0) {
        return {
          ok: false,
          message: `Sync failed for ${targetShop}: ${userErrors[0].message}`,
        };
      }

      const syncedProduct = createProductJson.data?.productCreate?.product;
      const targetVariantId = syncedProduct?.variants?.nodes?.[0]?.id;
      const shouldSyncVariantFields =
        selectedFields.has("sku") ||
        selectedFields.has("barcode") ||
        selectedFields.has("continue-selling-out-of-stock");

      if (shouldSyncVariantFields && targetVariantId && sourceVariant) {
        const variantInput = {
          id: targetVariantId,
        };

        if (selectedFields.has("sku")) {
          variantInput.sku = sourceVariant.sku || "";
        }

        if (selectedFields.has("barcode")) {
          variantInput.barcode = sourceVariant.barcode || null;
        }

        if (selectedFields.has("continue-selling-out-of-stock")) {
          variantInput.inventoryPolicy =
            sourceVariant.inventoryPolicy === "CONTINUE" ? "CONTINUE" : "DENY";
        }

        const updateVariantResponse = await targetAdmin.graphql(
          `#graphql
            mutation UpdateSyncedVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                userErrors {
                  field
                  message
                }
              }
            }`,
          {
            variables: {
              productId: syncedProduct.id,
              variants: [variantInput],
            },
          },
        );
        const updateVariantJson = await updateVariantResponse.json();
        const variantErrors =
          updateVariantJson.data?.productVariantsBulkUpdate?.userErrors ?? [];

        if (variantErrors.length > 0) {
          return {
            ok: false,
            message: `Product created in ${targetShop}, but variant sync failed: ${variantErrors[0].message}`,
          };
        }
      }
    }

    return {
      ok: true,
      message: `Synced "${sourceProduct.title}" to ${targetShops.length} store(s).`,
    };
  }

  if (intent === "disconnect-store") {
    const shopToDisconnect = String(formData.get("shop") || "")
      .trim()
      .toLowerCase();

    if (!shopToDisconnect) {
      return {
        ok: false,
        message: "Choose a store to disconnect.",
      };
    }

    if (shopToDisconnect === session.shop) {
      return {
        ok: false,
        message: "You cannot disconnect the current source store.",
      };
    }

    const result = await db.session.deleteMany({
      where: {
        shop: shopToDisconnect,
      },
    });

    if (result.count === 0) {
      return {
        ok: false,
        message: `No saved session found for ${shopToDisconnect}.`,
      };
    }

    return {
      ok: true,
      message: `Disconnected ${shopToDisconnect}.`,
    };
  }

  return {
    ok: false,
    message: "Unknown action.",
  };
};

export default function Index() {
  const {
    currentShop,
    sourceShop,
    searchQuery,
    products,
    connectedStores,
    availableSourceStores,
  } = useLoaderData();
  const syncFetcher = useFetcher();
  const disconnectFetcher = useFetcher();
  const shopify = useAppBridge();
  const [syncModalProduct, setSyncModalProduct] = useState(null);
  const [syncOptions, setSyncOptions] = useState({
    title: true,
    description: true,
    barcode: true,
    images: true,
    vendor: true,
    sku: true,
    continueSellingOutOfStock: true,
  });
  const [firstImageId, setFirstImageId] = useState("");
  const [selectedTargetShops, setSelectedTargetShops] = useState(
    [currentShop, ...connectedStores].filter((shopDomain) => shopDomain !== sourceShop),
  );
  const isSyncing = syncFetcher.state !== "idle";
  const disconnectingShop =
    disconnectFetcher.formData && disconnectFetcher.formData.get("intent") === "disconnect-store"
      ? String(disconnectFetcher.formData.get("shop") || "")
      : "";
  const hasConnectedStores = connectedStores.length > 0;
  const availableTargetStores = useMemo(
    () =>
      [currentShop, ...connectedStores].filter((shopDomain) => shopDomain !== sourceShop),
    [connectedStores, currentShop, sourceShop],
  );

  useEffect(() => {
    setSelectedTargetShops((previous) => {
      const preserved = previous.filter((shop) => availableTargetStores.includes(shop));
      return preserved.length > 0 ? preserved : [...availableTargetStores];
    });
  }, [availableTargetStores]);

  useEffect(() => {
    if (syncFetcher.data?.message) {
      shopify.toast.show(syncFetcher.data.message);
    }
  }, [shopify, syncFetcher.data?.message]);

  useEffect(() => {
    if (syncFetcher.data?.ok) {
      setSyncModalProduct(null);
    }
  }, [syncFetcher.data?.ok]);

  useEffect(() => {
    if (disconnectFetcher.data?.message) {
      shopify.toast.show(disconnectFetcher.data.message);
    }
  }, [disconnectFetcher.data?.message, shopify]);

  const emptySearchState = useMemo(() => {
    if (products.length > 0) {
      return null;
    }

    if (searchQuery) {
      return `No products found for "${searchQuery}".`;
    }

    return "No products found on this store yet.";
  }, [products, searchQuery]);

  const openSyncModal = (product) => {
    setSyncModalProduct(product);
    setSyncOptions({
      title: true,
      description: true,
      barcode: true,
      images: true,
      vendor: true,
      sku: true,
      continueSellingOutOfStock: true,
    });
    setFirstImageId(product.images?.nodes?.[0]?.id || "");
    setSelectedTargetShops((previous) => {
      if (previous.length > 0) {
        const preserved = previous.filter((shop) => availableTargetStores.includes(shop));
        if (preserved.length > 0) return preserved;
      }
      return [...availableTargetStores];
    });
  };

  const closeSyncModal = () => {
    if (isSyncing) return;
    setSyncModalProduct(null);
  };

  const selectedProductImages = syncModalProduct?.images?.nodes ?? [];

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
                <s-list-item key={shopDomain}>
                  <s-stack direction="inline" gap="base" alignItems="center">
                    <s-text>{shopDomain}</s-text>
                    <disconnectFetcher.Form
                      method="post"
                      onSubmit={(event) => {
                        const confirmed = window.confirm(
                          `Disconnect ${shopDomain}? You can reconnect later with OAuth.`,
                        );
                        if (!confirmed) {
                          event.preventDefault();
                        }
                      }}
                    >
                      <input type="hidden" name="intent" value="disconnect-store" />
                      <input type="hidden" name="shop" value={shopDomain} />
                      <s-button
                        type="submit"
                        tone="critical"
                        {...(disconnectingShop === shopDomain ? { loading: true } : {})}
                      >
                        Disconnect
                      </s-button>
                    </disconnectFetcher.Form>
                  </s-stack>
                </s-list-item>
              ))}
            </s-unordered-list>
          </s-box>
        ) : (
          <s-paragraph>No target stores connected yet.</s-paragraph>
        )}
      </s-section>

      <s-section heading="Search products in this store">
        <Form method="get">
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-select name="sourceShop" label="View products from" value={sourceShop}>
              {availableSourceStores.map((shopDomain) => (
                <option key={shopDomain} value={shopDomain}>
                  {shopDomain}
                </option>
              ))}
            </s-select>
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
        {emptySearchState ? (
          <s-paragraph>{emptySearchState}</s-paragraph>
        ) : (
          <s-stack gap="base">
            {products.map((product) => {
              const sku = product.variants?.nodes?.[0]?.sku || "N/A";
              return (
                <s-box
                  key={product.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-stack direction="inline" gap="base" alignItems="center">
                    {product.featuredImage?.url ? (
                      <img
                        src={product.featuredImage.url}
                        alt={product.featuredImage.altText || product.title}
                        width="48"
                        height="48"
                        style={{ objectFit: "cover", borderRadius: "6px", flexShrink: 0 }}
                      />
                    ) : (
                      <div
                        style={{
                          width: "48px",
                          height: "48px",
                          borderRadius: "6px",
                          border: "1px solid #d1d5db",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#6b7280",
                          fontSize: "12px",
                          flexShrink: 0,
                        }}
                      >
                        No image
                      </div>
                    )}
                    <s-stack gap="none">
                      <s-text>{product.title}</s-text>
                      <s-text tone="subdued">SKU: {sku}</s-text>
                      <s-text tone="subdued">
                        {product.vendor || "Unknown vendor"} {product.productType ? `- ${product.productType}` : ""}
                      </s-text>
                      <div>
                        <span
                          style={{
                            ...getProductStatusChipStyle(product.status),
                            borderRadius: "9999px",
                            padding: "2px 10px",
                            fontSize: "12px",
                            fontWeight: 600,
                            display: "inline-block",
                            lineHeight: 1.6,
                          }}
                        >
                          {product.status}
                        </span>
                      </div>
                    </s-stack>
                    <div style={{ marginLeft: "auto" }}>
                      <s-button
                        type="button"
                        disabled={availableTargetStores.length === 0}
                        onClick={() => openSyncModal(product)}
                      >
                        Sync
                      </s-button>
                    </div>
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>
        )}
      </s-section>

      {syncModalProduct && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: "16px",
          }}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "12px",
              border: "1px solid #e5e7eb",
              width: "100%",
              maxWidth: "560px",
              maxHeight: "85vh",
              overflowY: "auto",
              padding: "16px",
            }}
          >
            <s-stack gap="base">
              <s-text variant="headingMd">Select fields to sync</s-text>
              <s-text tone="subdued">
                Product: {syncModalProduct.title}
              </s-text>

              <syncFetcher.Form method="post">
                <input type="hidden" name="intent" value="sync-product" />
                <input type="hidden" name="productId" value={syncModalProduct.id} />
                <input type="hidden" name="sourceShop" value={sourceShop} />
                {selectedTargetShops.map((shopDomain) => (
                  <input
                    key={shopDomain}
                    type="hidden"
                    name="targetShops"
                    value={shopDomain}
                  />
                ))}
                {firstImageId ? <input type="hidden" name="firstImageId" value={firstImageId} /> : null}

                <s-stack gap="tight">
                  <s-select
                    label="Target stores (multi-select)"
                    value={selectedTargetShops}
                    multiple
                    onChange={(event) => {
                      const values = Array.from(event.currentTarget.selectedOptions).map(
                        (option) => option.value,
                      );
                      setSelectedTargetShops(values);
                    }}
                  >
                    {availableTargetStores.map((shopDomain) => (
                      <option key={shopDomain} value={shopDomain}>
                        {shopDomain}
                      </option>
                    ))}
                  </s-select>
                  <label>
                    <input
                      type="checkbox"
                      name="fields"
                      value="title"
                      checked={syncOptions.title}
                      onChange={(event) =>
                        setSyncOptions((previous) => ({
                          ...previous,
                          title: event.currentTarget.checked,
                        }))
                      }
                    />{" "}
                    Title
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      name="fields"
                      value="description"
                      checked={syncOptions.description}
                      onChange={(event) =>
                        setSyncOptions((previous) => ({
                          ...previous,
                          description: event.currentTarget.checked,
                        }))
                      }
                    />{" "}
                    Description
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      name="fields"
                      value="barcode"
                      checked={syncOptions.barcode}
                      onChange={(event) =>
                        setSyncOptions((previous) => ({
                          ...previous,
                          barcode: event.currentTarget.checked,
                        }))
                      }
                    />{" "}
                    Barcode
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      name="fields"
                      value="images"
                      checked={syncOptions.images}
                      onChange={(event) =>
                        setSyncOptions((previous) => ({
                          ...previous,
                          images: event.currentTarget.checked,
                        }))
                      }
                    />{" "}
                    Images
                  </label>
                  {syncOptions.images && selectedProductImages.length > 0 ? (
                    <s-select
                      label="First image in target store"
                      value={firstImageId}
                      onChange={(event) => setFirstImageId(event.currentTarget.value)}
                    >
                      {selectedProductImages.map((image, index) => (
                        <option key={image.id} value={image.id}>
                          {index + 1}. {image.altText || image.url}
                        </option>
                      ))}
                    </s-select>
                  ) : null}
                  <label>
                    <input
                      type="checkbox"
                      name="fields"
                      value="vendor"
                      checked={syncOptions.vendor}
                      onChange={(event) =>
                        setSyncOptions((previous) => ({
                          ...previous,
                          vendor: event.currentTarget.checked,
                        }))
                      }
                    />{" "}
                    Vendor
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      name="fields"
                      value="sku"
                      checked={syncOptions.sku}
                      onChange={(event) =>
                        setSyncOptions((previous) => ({
                          ...previous,
                          sku: event.currentTarget.checked,
                        }))
                      }
                    />{" "}
                    SKU
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      name="fields"
                      value="continue-selling-out-of-stock"
                      checked={syncOptions.continueSellingOutOfStock}
                      onChange={(event) =>
                        setSyncOptions((previous) => ({
                          ...previous,
                          continueSellingOutOfStock: event.currentTarget.checked,
                        }))
                      }
                    />{" "}
                    Continue Selling Out Of Stock
                  </label>
                </s-stack>

                <s-stack direction="inline" gap="base">
                  <s-button type="button" onClick={closeSyncModal} disabled={isSyncing}>
                    Cancel
                  </s-button>
                  <s-button
                    type="submit"
                    disabled={selectedTargetShops.length === 0}
                    {...(isSyncing ? { loading: true } : {})}
                  >
                    Sync selected fields
                  </s-button>
                </s-stack>
              </syncFetcher.Form>
            </s-stack>
          </div>
        </div>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
