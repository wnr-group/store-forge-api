import { SetMetadata } from '@nestjs/common';

export const RESPONSE_MESSAGE = 'responseMessage';

/** The `message` field of the success envelope, e.g. "Products retrieved successfully". */
export const ResponseMessage = (message: string) =>
  SetMetadata(RESPONSE_MESSAGE, message);
