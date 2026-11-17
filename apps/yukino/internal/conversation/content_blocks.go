package conversation

func NormalizeToolResultContentBlock(raw any) map[string]any {
	value, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	switch value["type"] {
	case "text":
		if text, ok := value["text"].(string); ok {
			return map[string]any{"type": "text", "text": text}
		}
	case "image":
		return normalizeImageBlock(value)
	case "tool_reference":
		if name, ok := value["tool_name"].(string); ok {
			return map[string]any{"type": "tool_reference", "tool_name": name}
		}
	case "search_result":
		source, sourceOK := value["source"].(string)
		title, titleOK := value["title"].(string)
		content, contentOK := value["content"].([]any)
		if !sourceOK || !titleOK || !contentOK {
			return nil
		}
		blocks := make([]map[string]any, 0, len(content))
		for _, raw := range content {
			block, ok := raw.(map[string]any)
			if !ok || block["type"] != "text" {
				return nil
			}
			normalized := NormalizeToolResultContentBlock(block)
			if normalized == nil {
				return nil
			}
			blocks = append(blocks, normalized)
		}
		return map[string]any{"type": "search_result", "source": source, "title": title, "content": blocks}
	case "document":
		source, ok := value["source"].(map[string]any)
		if !ok {
			return nil
		}
		var normalized map[string]any
		switch source["type"] {
		case "url":
			if url, ok := source["url"].(string); ok {
				normalized = map[string]any{"type": "url", "url": url}
			}
		case "base64", "text":
			data, dataOK := source["data"].(string)
			media := source["media_type"]
			if dataOK && (source["type"] == "base64" && media == "application/pdf" || source["type"] == "text" && media == "text/plain") {
				normalized = map[string]any{"type": source["type"], "media_type": media, "data": data}
			}
		case "content":
			if text, ok := source["content"].(string); ok {
				normalized = map[string]any{"type": "content", "content": text}
			} else if content, ok := source["content"].([]any); ok {
				blocks := make([]map[string]any, 0, len(content))
				for _, raw := range content {
					block, ok := raw.(map[string]any)
					if !ok || (block["type"] != "text" && block["type"] != "image") {
						return nil
					}
					normalizedBlock := NormalizeToolResultContentBlock(block)
					if normalizedBlock == nil {
						return nil
					}
					blocks = append(blocks, normalizedBlock)
				}
				normalized = map[string]any{"type": "content", "content": blocks}
			}
		}
		if normalized == nil {
			return nil
		}
		out := map[string]any{"type": "document", "source": normalized}
		for _, name := range []string{"title", "context"} {
			if v, exists := value[name]; exists {
				if _, ok := v.(string); ok || v == nil {
					out[name] = v
				}
			}
		}
		return out
	}
	return nil
}

func normalizeImageBlock(value map[string]any) map[string]any {
	source, ok := value["source"].(map[string]any)
	if !ok {
		return nil
	}
	if source["type"] == "url" {
		if url, ok := source["url"].(string); ok {
			return map[string]any{"type": "image", "source": map[string]any{"type": "url", "url": url}}
		}
	}
	media, mediaOK := source["media_type"].(string)
	data, dataOK := source["data"].(string)
	if source["type"] == "base64" && mediaOK && dataOK {
		switch media {
		case "image/jpeg", "image/png", "image/gif", "image/webp":
			return map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": media, "data": data}}
		}
	}
	return nil
}
