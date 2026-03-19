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
  const openSyncProductId = (url.searchParams.get("openSyncProductId") || "").trim();
  const openSyncProductIds = [
    ...new Set(
      String(url.searchParams.get("openSyncProductIds") || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];

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
                id
                sku
                barcode
                inventoryPolicy
                inventoryItem {
                  id
                  sku
                }
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
  const requestedOpenIds = openSyncProductIds.length > 0
    ? openSyncProductIds
    : openSyncProductId
      ? [openSyncProductId]
      : [];
  let openSyncProducts = [];

  if (requestedOpenIds.length > 0) {
    const openProductsResponse = await sourceAdmin.graphql(
      `#graphql
        query OpenSyncProducts($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
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
                  id
                  sku
                  barcode
                  inventoryPolicy
                  inventoryItem {
                    id
                    sku
                  }
                }
              }
            }
          }
        }`,
      {
        variables: {
          ids: requestedOpenIds,
        },
      },
    );
    const openProductsJson = await openProductsResponse.json();
    const openProductMap = new Map(
      (openProductsJson.data?.nodes ?? [])
        .filter(Boolean)
        .map((product) => [product.id, product]),
    );
    openSyncProducts = requestedOpenIds.map((id) => openProductMap.get(id)).filter(Boolean);
  }

  return {
    currentShop: session.shop,
    sourceShop,
    searchQuery,
    products,
    openSyncProductIds: requestedOpenIds,
    openSyncProducts,
    connectedStores,
    availableSourceStores,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "sync-product") {
    const productIds = [
      ...new Set(
        [
          ...formData.getAll("productIds"),
          formData.get("productId"),
        ]
          .map((id) => String(id || "").trim())
          .filter(Boolean),
      ),
    ];
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

    if (productIds.length === 0 || targetShops.length === 0 || !sourceShop) {
      return {
        ok: false,
        message: "Pick one or more target stores and products before syncing.",
      };
    }

    if (targetShops.includes(sourceShop)) {
      return {
        ok: false,
        message: "Source and target stores must be different.",
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

    const syncOneProduct = async (productId) => {
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
                  id
                  sku
                  barcode
                  inventoryPolicy
                  inventoryItem {
                    id
                    sku
                  }
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
          label: productId,
          reason: "could not load source product",
          updatedShops: [],
          failedShops: [],
          variantWarningShops: [],
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
      const mediaInput = selectedFields.has("images")
        ? orderedImages.map((image) => ({
            mediaContentType: "IMAGE",
            originalSource: image.url,
            alt: image.altText || sourceProduct.title,
          }))
        : [];

      const updatedShops = [];
      const failedShops = [];
      const variantWarningShops = [];
      const sourceSku = (sourceVariant?.sku || "").trim();

      if (!sourceSku) {
        return {
          ok: false,
          label: sourceProduct.title,
          reason: "source product has no SKU",
          updatedShops,
          failedShops,
          variantWarningShops,
        };
      }

      for (const targetShop of targetShops) {
        const targetAdmin =
          targetShop === session.shop
            ? admin
            : (await unauthenticated.admin(targetShop)).admin;
        let targetProductId = null;
        let targetVariantId = null;

        const lookupResponse = await targetAdmin.graphql(
          `#graphql
            query FindBySku($query: String!) {
              productVariants(first: 1, query: $query) {
                nodes {
                  id
                  product {
                    id
                  }
                }
              }
            }`,
          {
            variables: {
              query: `sku:${sourceSku}`,
            },
          },
        );
        const lookupJson = await lookupResponse.json();
        const existingVariant = lookupJson.data?.productVariants?.nodes?.[0] ?? null;
        targetProductId = existingVariant?.product?.id ?? null;
        targetVariantId = existingVariant?.id ?? null;

        if (targetProductId) {
          const productUpdateInput = { id: targetProductId };

          if (selectedFields.has("title")) {
            productUpdateInput.title = sourceProduct.title;
          }
          if (selectedFields.has("description")) {
            productUpdateInput.descriptionHtml = sourceProduct.descriptionHtml;
          }
          if (selectedFields.has("vendor")) {
            productUpdateInput.vendor = sourceProduct.vendor;
          }

          if (Object.keys(productUpdateInput).length > 1) {
            const productUpdateResponse = await targetAdmin.graphql(
              `#graphql
                mutation SyncExistingProduct($product: ProductUpdateInput!) {
                  productUpdate(product: $product) {
                    product {
                      id
                    }
                    userErrors {
                      field
                      message
                    }
                  }
                }`,
              {
                variables: {
                  product: productUpdateInput,
                },
              },
            );
            const productUpdateJson = await productUpdateResponse.json();
            const updateErrors = productUpdateJson.data?.productUpdate?.userErrors ?? [];
            if (updateErrors.length > 0) {
              failedShops.push(`${targetShop} (${updateErrors[0].message})`);
              continue;
            }
          }

          if (selectedFields.has("images") && mediaInput.length > 0) {
            const mediaResponse = await targetAdmin.graphql(
              `#graphql
                mutation AddImagesToExistingProduct($productId: ID!, $media: [CreateMediaInput!]!) {
                  productCreateMedia(productId: $productId, media: $media) {
                    mediaUserErrors {
                      field
                      message
                    }
                  }
                }`,
              {
                variables: {
                  productId: targetProductId,
                  media: mediaInput,
                },
              },
            );
            const mediaJson = await mediaResponse.json();
            const mediaErrors = mediaJson.data?.productCreateMedia?.mediaUserErrors ?? [];
            if (mediaErrors.length > 0) {
              variantWarningShops.push(
                `${targetShop} (image update failed: ${mediaErrors[0].message})`,
              );
            }
          }

          updatedShops.push(targetShop);
        } else {
          failedShops.push(`${targetShop} (no product found with SKU "${sourceSku}")`);
          continue;
        }

        const shouldSyncVariantFields =
          selectedFields.has("barcode") ||
          selectedFields.has("continue-selling-out-of-stock");

        if (shouldSyncVariantFields && targetVariantId && sourceVariant) {
          const baseVariantInput = {
            id: targetVariantId,
          };
          if (selectedFields.has("continue-selling-out-of-stock")) {
            baseVariantInput.inventoryPolicy =
              sourceVariant.inventoryPolicy === "CONTINUE" ? "CONTINUE" : "DENY";
          }

          const attempts = [];
          const barcodeValue = sourceVariant.barcode ?? "";
          const wantsBarcode = selectedFields.has("barcode");

          const topLevelBarcodeInput = { ...baseVariantInput };
          if (wantsBarcode) {
            topLevelBarcodeInput.barcode = barcodeValue;
          }
          attempts.push(topLevelBarcodeInput);

          if (wantsBarcode) {
            const nestedInventoryInput = { ...baseVariantInput, inventoryItem: {} };
            nestedInventoryInput.inventoryItem.barcode = barcodeValue;
            attempts.push(nestedInventoryInput);
          }

          let variantUpdated = false;
          let lastVariantError = "";

          for (const variantAttemptInput of attempts) {
            if (Object.keys(variantAttemptInput).length <= 1) {
              continue;
            }

            try {
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
                    productId: targetProductId,
                    variants: [variantAttemptInput],
                  },
                },
              );
              const updateVariantJson = await updateVariantResponse.json();
              const queryErrors = updateVariantJson.errors ?? [];
              const variantErrors =
                updateVariantJson.data?.productVariantsBulkUpdate?.userErrors ?? [];

              if (queryErrors.length === 0 && variantErrors.length === 0) {
                variantUpdated = true;
                break;
              }

              lastVariantError =
                variantErrors[0]?.message ||
                queryErrors[0]?.message ||
                "unknown variant update error";
            } catch (error) {
              lastVariantError = error?.message || "unknown variant update error";
            }
          }

          if (!variantUpdated && lastVariantError) {
            variantWarningShops.push(`${targetShop} (${lastVariantError})`);
          }
        }
      }

      return {
        ok: updatedShops.length > 0,
        label: sourceProduct.title,
        reason:
          updatedShops.length > 0
            ? ""
            : failedShops.length > 0
              ? failedShops.join(", ")
              : "no matched stores were updated",
        updatedShops,
        failedShops,
        variantWarningShops,
      };
    };

    const syncedProducts = [];
    const failedProducts = [];
    const warnings = [];
    let totalStoreUpdates = 0;

    for (const productId of productIds) {
      const result = await syncOneProduct(productId);
      if (result.ok) {
        syncedProducts.push(result.label);
        totalStoreUpdates += result.updatedShops.length;
      } else {
        failedProducts.push(`${result.label} (${result.reason})`);
      }

      if (result.variantWarningShops.length > 0) {
        warnings.push(
          `${result.label}: ${result.variantWarningShops.join(", ")}`,
        );
      }
    }

    if (syncedProducts.length === 0) {
      return {
        ok: false,
        message: `Sync failed for all selected products. ${failedProducts.join(" | ")}`,
      };
    }

    const messageParts = [
      `Synced ${syncedProducts.length} product(s) across ${totalStoreUpdates} matched store update(s).`,
    ];
    if (syncedProducts.length <= 5) {
      messageParts.push(`Products: ${syncedProducts.join(", ")}.`);
    }
    if (warnings.length > 0) {
      messageParts.push(`Some variant/image updates had warnings: ${warnings.join(" | ")}.`);
    }
    if (failedProducts.length > 0) {
      messageParts.push(`Failed products: ${failedProducts.join(" | ")}.`);
    }

    return {
      ok: true,
      message: messageParts.join(" "),
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
    openSyncProductIds,
    openSyncProducts,
    connectedStores,
    availableSourceStores,
  } = useLoaderData();
  const syncFetcher = useFetcher();
  const shopify = useAppBridge();
  const [syncModalProducts, setSyncModalProducts] = useState([]);
  const [selectedProductIds, setSelectedProductIds] = useState([]);
  const [hasHandledOpenSyncParams, setHasHandledOpenSyncParams] = useState(false);
  const [syncOptions, setSyncOptions] = useState({
    title: true,
    description: true,
    barcode: true,
    images: true,
    vendor: true,
    continueSellingOutOfStock: true,
  });
  const [firstImageId, setFirstImageId] = useState("");
  const [selectedTargetShops, setSelectedTargetShops] = useState(
    [currentShop, ...connectedStores].filter((shopDomain) => shopDomain !== sourceShop),
  );
  const isSyncing = syncFetcher.state !== "idle";
  const isBulkSyncMode = syncModalProducts.length > 1;
  const syncModalProduct = syncModalProducts[0] || null;
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
    setHasHandledOpenSyncParams(false);
  }, [openSyncProductIds, sourceShop]);

  useEffect(() => {
    if (openSyncProductIds.length === 0 || hasHandledOpenSyncParams) {
      return;
    }

    setHasHandledOpenSyncParams(true);

    if (!openSyncProducts || openSyncProducts.length === 0) {
      return;
    }

    setSyncModalProducts(openSyncProducts);
    setSelectedProductIds(openSyncProducts.map((product) => product.id));
    setSyncOptions({
      title: true,
      description: true,
      barcode: true,
      images: true,
      vendor: true,
      continueSellingOutOfStock: true,
    });
    setFirstImageId(openSyncProducts[0]?.images?.nodes?.[0]?.id || "");
    setSelectedTargetShops((previous) => {
      if (previous.length > 0) {
        const preserved = previous.filter((shop) => availableTargetStores.includes(shop));
        if (preserved.length > 0) return preserved;
      }
      return [...availableTargetStores];
    });
  }, [availableTargetStores, hasHandledOpenSyncParams, openSyncProductIds, openSyncProducts]);

  useEffect(() => {
    if (syncFetcher.data?.message) {
      shopify.toast.show(syncFetcher.data.message);
    }
  }, [shopify, syncFetcher.data?.message]);

  useEffect(() => {
    if (syncFetcher.data?.ok) {
      setSyncModalProducts([]);
      setSelectedProductIds([]);
    }
  }, [syncFetcher.data?.ok]);

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
    setSyncModalProducts([product]);
    setSelectedProductIds([product.id]);
    setSyncOptions({
      title: true,
      description: true,
      barcode: true,
      images: true,
      vendor: true,
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

  const openBulkSyncModal = () => {
    const selectedProducts = products.filter((product) => selectedProductIds.includes(product.id));
    if (selectedProducts.length === 0) {
      return;
    }

    setSyncModalProducts(selectedProducts);
    setSyncOptions({
      title: true,
      description: true,
      barcode: true,
      images: true,
      vendor: true,
      continueSellingOutOfStock: true,
    });
    setFirstImageId("");
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
    setSyncModalProducts([]);
  };

  const selectedProductImages = !isBulkSyncMode ? syncModalProduct?.images?.nodes ?? [] : [];
  const selectedProductSkuRows = useMemo(
    () =>
      syncModalProducts.map((product) => {
        const sku = (product.variants?.nodes?.[0]?.sku || "").trim() || "N/A";
        return {
          id: product.id,
          title: product.title,
          sku,
        };
      }),
    [syncModalProducts],
  );
  const sectionHeadingStyle = { fontSize: "14px" };
  const selectedFieldValues = useMemo(() => {
    const fields = [];
    if (syncOptions.title) fields.push("title");
    if (syncOptions.description) fields.push("description");
    if (syncOptions.barcode) fields.push("barcode");
    if (syncOptions.images) fields.push("images");
    if (syncOptions.vendor) fields.push("vendor");
    if (syncOptions.continueSellingOutOfStock) fields.push("continue-selling-out-of-stock");
    return fields;
  }, [syncOptions]);

  return (
    <s-page heading="Store sync">
      <s-section heading="Overview">
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          style={{ background: "#f8fafc" }}
        >
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-text>Current store: {currentShop}</s-text>
            <s-text tone="subdued">Connected targets: {connectedStores.length}</s-text>
            <div style={{ marginLeft: "auto" }}>
              <s-link href="/app/additional">Manage OAuth stores</s-link>
            </div>
          </s-stack>
        </s-box>
      </s-section>

      <s-section heading="Search products in this store">
        <Form method="get">
          <s-stack direction="inline" gap="base" alignItems="end">
            <div>
              <label htmlFor="sourceShopSelect">View products from</label>
              <select
                id="sourceShopSelect"
                name="sourceShop"
                defaultValue={sourceShop}
                style={{
                  width: "260px",
                  padding: "10px",
                  borderRadius: "8px",
                  border: "1px solid #d1d5db",
                  background: "#ffffff",
                }}
              >
                {availableSourceStores.map((shopDomain) => (
                  <option key={shopDomain} value={shopDomain}>
                    {shopDomain}
                  </option>
                ))}
              </select>
            </div>
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
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-text tone="subdued">{selectedProductIds.length} product(s) selected.</s-text>
              <s-button
                type="button"
                disabled={selectedProductIds.length === 0 || availableTargetStores.length === 0}
                onClick={openBulkSyncModal}
              >
                Sync selected products
              </s-button>
            </s-stack>
            {products.map((product) => {
              const sku = product.variants?.nodes?.[0]?.sku || "N/A";
              const isSelected = selectedProductIds.includes(product.id);
              const secondaryMeta = [
                `${sku}`,
                product.vendor || "Unknown vendor",
                product.productType || "Uncategorized",
              ];
              return (
                <s-box
                  key={product.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                  style={{
                    background: "#ffffff",
                    borderColor: isSelected ? "#3b82f6" : "#dfe3e8",
                    boxShadow: isSelected
                      ? "0 0 0 2px rgba(59, 130, 246, 0.14)"
                      : "0 1px 0 rgba(17, 24, 39, 0.05)",
                  }}
                >
                  <s-stack direction="inline" gap="base" alignItems="center">
                    <s-checkbox
                      aria-label={`Select ${product.title}`}
                      checked={isSelected}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setSelectedProductIds((previous) => {
                          if (checked) {
                            return previous.includes(product.id)
                              ? previous
                              : [...previous, product.id];
                          }
                          return previous.filter((id) => id !== product.id);
                        });
                      }}
                    ></s-checkbox>
                    {product.featuredImage?.url ? (
                      <img
                        src={product.featuredImage.url}
                        alt={product.featuredImage.altText || product.title}
                        width="56"
                        height="56"
                        style={{ objectFit: "cover", borderRadius: "8px", flexShrink: 0 }}
                      />
                    ) : (
                      <div
                        style={{
                          width: "56px",
                          height: "56px",
                          borderRadius: "8px",
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
                    <s-stack gap="none" style={{ flex: 1, minWidth: 0 }}>
                      <s-stack direction="inline" gap="tight" alignItems="center">
                        <s-text type="strong">{product.title}</s-text>
                        {isSelected ? (
                          <span
                            style={{
                              borderRadius: "9999px",
                              border: "1px solid #bfdbfe",
                              background: "#eff6ff",
                              color: "#1e40af",
                              fontSize: "11px",
                              fontWeight: 600,
                              padding: "2px 8px",
                              lineHeight: 1.5,
                            }}
                          >
                            Selected
                          </span>
                        ) : null}
                      </s-stack>
                      <s-text tone="subdued">{secondaryMeta.join("  •  ")}</s-text>
                    </s-stack>
                    <div
                      style={{
                        marginLeft: "auto",
                        minWidth: "148px",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-end",
                        justifyContent: "center",
                        gap: "8px",
                      }}
                    >
                      <div style={{ display: "inline-flex" }}>
                        <span
                          style={{
                            ...getProductStatusChipStyle(product.status),
                            borderRadius: "9999px",
                            padding: "3px 10px",
                            fontSize: "12px",
                            fontWeight: 600,
                            display: "inline-block",
                            lineHeight: 1.6,
                          }}
                        >
                          {product.status}
                        </span>
                      </div>
                      <s-button
                        type="button"
                        disabled={availableTargetStores.length === 0}
                        onClick={() => openSyncModal(product)}
                      >
                        Configure sync
                      </s-button>
                    </div>
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>
        )}
      </s-section>

      {syncModalProducts.length > 0 && (
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
              borderRadius: "14px",
              border: "1px solid #e5e7eb",
              width: "100%",
              maxWidth: "720px",
              maxHeight: "85vh",
              overflowY: "auto",
              padding: "24px",
            }}
          >
            <s-stack gap="base">
              <s-text type="strong" style={{ fontSize: "16px" }}>
                Select fields to sync
              </s-text>
              <s-text tone="subdued">
                {isBulkSyncMode
                  ? `Products selected: ${syncModalProducts.length}`
                  : `Product: ${syncModalProduct?.title || ""}`}
              </s-text>
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                style={{ background: "#f8fafc" }}
              >
                <s-stack gap="tight">
                  <s-text type="strong" style={sectionHeadingStyle}>
                    Selected SKUs
                  </s-text>
                  <div style={{ display: "grid", gap: "6px", maxHeight: "140px", overflowY: "auto" }}>
                    {selectedProductSkuRows.map((row) => (
                      <s-stack key={row.id} direction="inline" gap="tight" alignItems="center">
                        <s-text>{row.title}</s-text>
                        <s-text tone="subdued">SKU: {row.sku}</s-text>
                      </s-stack>
                    ))}
                  </div>
                </s-stack>
              </s-box>

              <syncFetcher.Form method="post">
                <input type="hidden" name="intent" value="sync-product" />
                {syncModalProducts.map((product) => (
                  <input key={product.id} type="hidden" name="productIds" value={product.id} />
                ))}
                <input type="hidden" name="sourceShop" value={sourceShop} />
                {selectedTargetShops.map((shopDomain) => (
                  <input
                    key={shopDomain}
                    type="hidden"
                    name="targetShops"
                    value={shopDomain}
                  />
                ))}
                {!isBulkSyncMode && firstImageId ? (
                  <input type="hidden" name="firstImageId" value={firstImageId} />
                ) : null}
                {selectedFieldValues.map((field) => (
                  <input key={field} type="hidden" name="fields" value={field} />
                ))}

                <s-stack gap="loose">
                  <s-box padding="base" borderWidth="base" borderRadius="base">
                    <s-stack gap="base">
                      <s-text type="strong" style={sectionHeadingStyle}>
                        Where to sync
                      </s-text>
                      <s-stack direction="inline" gap="tight" alignItems="center">
                        <s-text tone="subdued">{selectedTargetShops.length} store(s) selected</s-text>
                        <s-button
                          type="button"
                          variant="plain"
                          onClick={() => setSelectedTargetShops([...availableTargetStores])}
                        >
                          Select all
                        </s-button>
                        <s-button
                          type="button"
                          variant="plain"
                          onClick={() => setSelectedTargetShops([])}
                        >
                          Clear
                        </s-button>
                      </s-stack>
                      <div>
                        <label htmlFor="targetStoresMultiSelect">Target stores (multi-select)</label>
                        <select
                          id="targetStoresMultiSelect"
                          multiple
                          value={selectedTargetShops}
                          onChange={(event) => {
                            const values = Array.from(event.currentTarget.selectedOptions).map(
                              (option) => option.value,
                            );
                            setSelectedTargetShops(values);
                          }}
                          style={{
                            width: "100%",
                            minHeight: "140px",
                            padding: "12px",
                            borderRadius: "8px",
                            border: "1px solid #d1d5db",
                            background: "#ffffff",
                          }}
                        >
                          {availableTargetStores.map((shopDomain) => (
                            <option key={shopDomain} value={shopDomain}>
                              {shopDomain}
                            </option>
                          ))}
                        </select>
                      </div>
                    </s-stack>
                  </s-box>
                  <s-box padding="base" borderWidth="base" borderRadius="base">
                    <s-stack gap="base">
                      <s-text type="strong" style={sectionHeadingStyle}>
                        Fields to sync
                      </s-text>
                      <s-stack direction="inline" gap="tight" alignItems="center">
                        <s-button
                          type="button"
                          variant="plain"
                          onClick={() =>
                            setSyncOptions({
                              title: true,
                              description: true,
                              barcode: true,
                              images: true,
                              vendor: true,
                              continueSellingOutOfStock: true,
                            })
                          }
                        >
                          Select all fields
                        </s-button>
                        <s-button
                          type="button"
                          variant="plain"
                          onClick={() =>
                            setSyncOptions({
                              title: false,
                              description: false,
                              barcode: false,
                              images: false,
                              vendor: false,
                              continueSellingOutOfStock: false,
                            })
                          }
                        >
                          Clear fields
                        </s-button>
                      </s-stack>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
                          gap: "10px 14px",
                        }}
                      >
                        <s-checkbox
                          label="Title"
                          checked={syncOptions.title}
                          onChange={(event) =>
                            setSyncOptions((previous) => ({
                              ...previous,
                              title: event.currentTarget.checked,
                            }))
                          }
                        ></s-checkbox>
                        <s-checkbox
                          label="Description"
                          checked={syncOptions.description}
                          onChange={(event) =>
                            setSyncOptions((previous) => ({
                              ...previous,
                              description: event.currentTarget.checked,
                            }))
                          }
                        ></s-checkbox>
                        <s-checkbox
                          label="Barcode"
                          checked={syncOptions.barcode}
                          onChange={(event) =>
                            setSyncOptions((previous) => ({
                              ...previous,
                              barcode: event.currentTarget.checked,
                            }))
                          }
                        ></s-checkbox>
                        <s-checkbox
                          label="Images"
                          checked={syncOptions.images}
                          onChange={(event) =>
                            setSyncOptions((previous) => ({
                              ...previous,
                              images: event.currentTarget.checked,
                            }))
                          }
                        ></s-checkbox>
                        <s-checkbox
                          label="Vendor"
                          checked={syncOptions.vendor}
                          onChange={(event) =>
                            setSyncOptions((previous) => ({
                              ...previous,
                              vendor: event.currentTarget.checked,
                            }))
                          }
                        ></s-checkbox>
                        <s-checkbox
                          label="Continue Selling Out Of Stock"
                          checked={syncOptions.continueSellingOutOfStock}
                          onChange={(event) =>
                            setSyncOptions((previous) => ({
                              ...previous,
                              continueSellingOutOfStock: event.currentTarget.checked,
                            }))
                          }
                        ></s-checkbox>
                      </div>
                      {syncOptions.images && selectedProductImages.length > 0 ? (
                        <div style={{ marginTop: "6px" }}>
                          <label htmlFor="firstImageSelect">First image in target store</label>
                          <select
                            id="firstImageSelect"
                            value={firstImageId}
                            onChange={(event) => setFirstImageId(event.currentTarget.value)}
                            style={{
                              width: "100%",
                              padding: "10px",
                              borderRadius: "8px",
                              border: "1px solid #d1d5db",
                              background: "#ffffff",
                            }}
                          >
                            {selectedProductImages.map((image, index) => (
                              <option key={image.id} value={image.id}>
                                {index + 1}. {image.altText || image.url}
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : null}
                    </s-stack>
                  </s-box>
                </s-stack>

                <s-stack direction="inline" gap="base" style={{ marginTop: "16px", justifyContent: "flex-end" }}>
                  <s-button type="button" onClick={closeSyncModal} disabled={isSyncing}>
                    Cancel
                  </s-button>
                  <s-button
                    type="submit"
                    disabled={selectedTargetShops.length === 0 || selectedFieldValues.length === 0}
                    {...(isSyncing ? { loading: true } : {})}
                  >
                    Start sync
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
