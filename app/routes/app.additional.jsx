import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

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
    connectedStores: connectedStoreSessions.map((record) => record.shop),
  };
};

export const action = async ({ request }) => {
  const { session, redirect } = await authenticate.admin(request);
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

export default function AdditionalPage() {
  const { currentShop, connectedStores } = useLoaderData();
  const actionFetcher = useFetcher();
  const shopify = useAppBridge();
  const hasConnectedStores = connectedStores.length > 0;
  const disconnectingShop =
    actionFetcher.formData && actionFetcher.formData.get("intent") === "disconnect-store"
      ? String(actionFetcher.formData.get("shop") || "")
      : "";

  useEffect(() => {
    if (actionFetcher.data?.message) {
      shopify.toast.show(actionFetcher.data.message);
    }
  }, [actionFetcher.data?.message, shopify]);

  return (
    <s-page heading="OAuth stores">
      <s-section heading="Connect another store">
        <s-text tone="subdued">
          Current store: {currentShop}
        </s-text>
        <actionFetcher.Form method="post">
          <input type="hidden" name="intent" value="connect-store" />
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-text-field
              name="targetShop"
              label="Store domain"
              details="example.myshopify.com"
              placeholder="target-store.myshopify.com"
            ></s-text-field>
            <s-button type="submit">Connect with OAuth</s-button>
          </s-stack>
        </actionFetcher.Form>
      </s-section>

      <s-section heading="Connected OAuth stores">
        {hasConnectedStores ? (
          <s-stack gap="tight">
            {connectedStores.map((shopDomain) => (
              <s-box
                key={shopDomain}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                style={{ background: "#ffffff" }}
              >
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-text>{shopDomain}</s-text>
                  <div style={{ marginLeft: "auto" }}>
                    <actionFetcher.Form
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
                    </actionFetcher.Form>
                  </div>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        ) : (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text tone="subdued">No target stores connected yet.</s-text>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
