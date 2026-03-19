import "@shopify/ui-extensions/preact";
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';

export default async () => {
  render(<Extension />, document.body);
}

function buildEmbeddedAppHref(launchUrl, productIds) {
  const normalizedIds = [...new Set((productIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  const query = normalizedIds.length > 0
    ? `?openSyncProductIds=${encodeURIComponent(normalizedIds.join(','))}`
    : '';

  try {
    const parsedLaunchUrl = new URL(String(launchUrl));
    const pathParts = parsedLaunchUrl.pathname.split('/').filter(Boolean);

    if (pathParts[0] === 'store' && pathParts[1]) {
      return `${parsedLaunchUrl.origin}/store/${pathParts[1]}/apps/sync-in/app${query}`;
    }

    if (pathParts[0] === 'admin') {
      return `${parsedLaunchUrl.origin}/admin/apps/sync-in/app${query}`;
    }
  } catch (error) {
    console.error('Could not parse launch URL:', error);
  }

  return `/apps/sync-in/app${query}`;
}

function Extension() {
  const {i18n, close, data, intents, extension: {target}} = shopify;
  console.log({data});
  const [productTitle, setProductTitle] = useState('');
  const selectedProductIds = (data?.selected || []).map((entry) => entry?.id).filter(Boolean);
  const selectedProductId = selectedProductIds[0] || '';
  const appSyncModalHref = buildEmbeddedAppHref(intents?.launchUrl, selectedProductIds);
  // Use direct API calls to fetch data from Shopify.
  // See https://shopify.dev/docs/api/admin-graphql for more information about Shopify's GraphQL API
  useEffect(() => {
    if (!selectedProductId) {
      setProductTitle('');
      return;
    }

    (async function getProductInfo() {
      const getProductQuery = {
        query: `query Product($id: ID!) {
          product(id: $id) {
            title
          }
        }`,
        variables: {id: selectedProductId},
      };

      const res = await fetch("shopify:admin/api/graphql.json", {
        method: "POST",
        body: JSON.stringify(getProductQuery),
      });

      if (!res.ok) {
        console.error('Network error');
      }

      const productData = await res.json();
      setProductTitle(productData.data.product.title);
    })();
  }, [selectedProductId]);
  return (
    // The AdminAction component provides an API for setting the title and actions of the Action extension wrapper.
    <s-admin-action heading="Sync product">
      <s-stack direction="block">
        {/* Set the translation values for each supported language in the locales directory */}
        <s-text type="strong">{i18n.translate('welcome', {target})}</s-text>
        <s-text>
          {selectedProductIds.length > 1
            ? `Selected products: ${selectedProductIds.length}`
            : `Current product: ${productTitle}`}
        </s-text>
        <s-text tone="neutral">
          Open the app sync modal for the selected product set.
        </s-text>
      </s-stack>
      <s-button slot="primary-action" href={appSyncModalHref} target="_top">
        Open sync modal
      </s-button>
      <s-button slot="secondary-actions" onClick={() => {
          console.log('closing');
          close();
      }}>Close</s-button>
    </s-admin-action>
  );
}