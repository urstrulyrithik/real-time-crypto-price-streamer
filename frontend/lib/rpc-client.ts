import { createPromiseClient } from '@connectrpc/connect';
import { createConnectTransport } from "@connectrpc/connect-web";
import { PriceService } from './generated/proto/price_connect';

const transport = createConnectTransport({
  baseUrl: 'http://localhost:4000',
});

export const priceClient = createPromiseClient(PriceService, transport);
