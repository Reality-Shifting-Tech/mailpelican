import {
  Body,
  Button,
  Container,
  Heading,
  Hr,
  Html,
  Img,
  Section,
  Text,
} from "@react-email/components";
import { render } from "@react-email/render";
import type { ReactElement } from "react";
import type { DesignBlock, DesignDocument } from "./design-document.js";

export interface RenderedDesign {
  html: string;
  text: string;
}

function blockElement(block: DesignBlock, index: number, plain: boolean): ReactElement {
  switch (block.type) {
    case "heading":
      // The plain-text converter uppercases headings, which would corrupt
      // case-sensitive merge tags; render bold text in the plain pass.
      return plain ? (
        <Text key={index} style={{ fontWeight: "bold", textAlign: block.align ?? "left" }}>
          {block.content}
        </Text>
      ) : (
        <Heading key={index} as="h2" style={{ textAlign: block.align ?? "left" }}>
          {block.content}
        </Heading>
      );
    case "text":
      return (
        <Text key={index} style={{ textAlign: block.align ?? "left" }}>
          {block.content}
        </Text>
      );
    case "button":
      return (
        <Section key={index} style={{ textAlign: block.align ?? "left" }}>
          <Button
            href={block.href}
            style={{
              backgroundColor: "#1a1a1a",
              color: "#ffffff",
              padding: "12px 24px",
              borderRadius: "4px",
              textDecoration: "none",
            }}
          >
            {block.label}
          </Button>
        </Section>
      );
    case "image":
      return (
        <Img
          key={index}
          src={block.src}
          alt={block.alt}
          width={block.width ?? 560}
          style={{ maxWidth: "100%" }}
        />
      );
    case "divider":
      return <Hr key={index} />;
  }
}

/**
 * Compile a design document to client-safe HTML and a plain-text alternative
 * via React Email (ADR-0002). Merge tags (`{{ ... }}`) are opaque text here;
 * the send pipeline substitutes them per recipient afterwards.
 */
export async function renderDesign(document: DesignDocument): Promise<RenderedDesign> {
  const build = (plain: boolean) => (
    <Html lang="en">
      <Body style={{ backgroundColor: "#ffffff", fontFamily: "Helvetica, Arial, sans-serif" }}>
        <Container style={{ maxWidth: "600px", margin: "0 auto", padding: "24px" }}>
          {document.children.map((block, index) => blockElement(block, index, plain))}
        </Container>
      </Body>
    </Html>
  );
  const html = await render(build(false));
  const text = await render(build(true), { plainText: true });
  return { html, text };
}
