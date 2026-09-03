import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SKILL_MARKDOWN_COMPONENTS: Components = {
  // External navigation is intercepted by Tokkey's main-window policy.
  a: ({ node: _node, ...properties }) => (
    <a {...properties} target="_blank" rel="noreferrer" />
  )
};

export interface SkillMarkdownProps {
  content: string;
}

/** Renders trusted local SKILL.md text without executing embedded HTML. */
export function SkillMarkdown({ content }: SkillMarkdownProps) {
  return (
    <div
      className="skill-markdown w-full select-text break-words text-[12px] leading-[18px] text-text-primary"
      data-testid="skill-details-content"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={SKILL_MARKDOWN_COMPONENTS}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
