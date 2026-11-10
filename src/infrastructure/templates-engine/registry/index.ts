// GENERATED from wnr-group/store-forge lib/templates/registry/index.ts. DO NOT EDIT.

import type { ComponentRegistry } from "../engine/descriptors.js";

// Section definitions (18 approved sections)
import { announcementBarSection } from "./sections/announcement-bar.js";
import { headerSection } from "./sections/header.js";
import { footerSection } from "./sections/footer.js";
import { heroSection } from "./sections/hero.js";
import { imageBannerSection } from "./sections/image-banner.js";
import { richTextSection } from "./sections/rich-text.js";
import { imageWithTextSection } from "./sections/image-with-text.js";
import { multicolumnSection } from "./sections/multicolumn.js";
import { collapsibleContentSection } from "./sections/collapsible-content.js";
import { testimonialsSection } from "./sections/testimonials.js";
import { productGridSection } from "./sections/product-grid.js";
import { collectionListSection } from "./sections/collection-list.js";
import { featuredCollectionSection } from "./sections/featured-collection.js";
import { collectionBannerSection } from "./sections/collection-banner.js";
import { mainProductSection } from "./sections/main-product.js";
import { relatedProductsSection } from "./sections/related-products.js";
import { promotionalBannerSection } from "./sections/promotional-banner.js";
import { logoListSection } from "./sections/logo-list.js";

// Block definitions (21 approved blocks)
import { headingBlock } from "./blocks/heading.js";
import { textBlock } from "./blocks/text.js";
import { buttonBlock } from "./blocks/button.js";
import { imageBlock } from "./blocks/image.js";
import { linkBlock } from "./blocks/link.js";
import { linkColumnBlock } from "./blocks/link-column.js";
import { socialLinkBlock } from "./blocks/social-link.js";
import { columnBlock } from "./blocks/column.js";
import { collapsibleItemBlock } from "./blocks/collapsible-item.js";
import { testimonialBlock } from "./blocks/testimonial.js";
import { groupBlock } from "./blocks/group.js";
import { productTitleBlock } from "./blocks/product-title.js";
import { productPriceBlock } from "./blocks/product-price.js";
import { productCompareAtPriceBlock } from "./blocks/product-compare-at-price.js";
import { productSkuBlock } from "./blocks/product-sku.js";
import { productTypeBlock } from "./blocks/product-type.js";
import { productCategoryBlock } from "./blocks/product-category.js";
import { productDescriptionBlock } from "./blocks/product-description.js";
import { variantPickerBlock } from "./blocks/variant-picker.js";
import { collapsibleInfoBlock } from "./blocks/collapsible-info.js";
import { socialShareBlock } from "./blocks/social-share.js";

export function getRegistry(): ComponentRegistry {
  return {
    sections: {
      "announcement-bar": announcementBarSection,
      header: headerSection,
      footer: footerSection,
      hero: heroSection,
      "image-banner": imageBannerSection,
      "rich-text": richTextSection,
      "image-with-text": imageWithTextSection,
      multicolumn: multicolumnSection,
      "collapsible-content": collapsibleContentSection,
      testimonials: testimonialsSection,
      "product-grid": productGridSection,
      "collection-list": collectionListSection,
      "featured-collection": featuredCollectionSection,
      "collection-banner": collectionBannerSection,
      "main-product": mainProductSection,
      "related-products": relatedProductsSection,
      "promotional-banner": promotionalBannerSection,
      "logo-list": logoListSection,
    },
    blocks: {
      heading: headingBlock,
      text: textBlock,
      button: buttonBlock,
      image: imageBlock,
      link: linkBlock,
      "link-column": linkColumnBlock,
      "social-link": socialLinkBlock,
      column: columnBlock,
      "collapsible-item": collapsibleItemBlock,
      testimonial: testimonialBlock,
      group: groupBlock,
      "product-title": productTitleBlock,
      "product-price": productPriceBlock,
      "product-compare-at-price": productCompareAtPriceBlock,
      "product-sku": productSkuBlock,
      "product-type": productTypeBlock,
      "product-category": productCategoryBlock,
      "product-description": productDescriptionBlock,
      "variant-picker": variantPickerBlock,
      "collapsible-info": collapsibleInfoBlock,
      "social-share": socialShareBlock,
    },
  };
}
