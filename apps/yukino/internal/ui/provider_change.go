package ui

import (
	"fmt"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/mcp"
)

type providerChangeDoneMsg struct {
	provider  config.ProviderConfig
	modelOnly bool
	client    llm.Client
	err       error
}

func (m Model) startProviderChange(provider config.ProviderConfig, modelOnly bool) (tea.Model, tea.Cmd) {
	m.providerDialog = false
	m.modelDialog = false
	m.providerSwitching = true
	wd, tasks := m.getWorkDir(), m.memoryTasks
	return m, tea.Batch(m.spinner.Tick, func() tea.Msg {
		client, err := llm.NewClient(&provider, providerSystemPrompt(&provider, wd))
		if err == nil && tasks != nil {
			tasks.Dispose()
		}
		return providerChangeDoneMsg{provider: provider, modelOnly: modelOnly, client: client, err: err}
	})
}

func (m Model) finishProviderChange(msg providerChangeDoneMsg) (tea.Model, tea.Cmd) {
	m.providerSwitching = false
	if m.lifeCtx.Err() != nil {
		return m, nil
	}
	if msg.err != nil {
		kind := "provider"
		if msg.modelOnly {
			kind = "model"
		}
		m.activityError = fmt.Sprintf("Failed to switch %s: %s", kind, msg.err)
		return m, nil
	}
	m.memoryGeneration++
	m.memoryTasks = nil
	provider := msg.provider
	m.selectedProvider = &provider
	if msg.modelOnly {
		for i := range m.providers {
			if m.providers[i].BaseURL == provider.BaseURL {
				m.providers[i].Model = provider.Model
			}
		}
	} else {
		index := 0
		for i := range m.providers {
			if m.providers[i].BaseURL == provider.BaseURL && m.providers[i].Name == provider.Name {
				index = i
				break
			}
		}
		_ = config.PersistDefaultProvider(index)
	}
	m.bindClient(msg.client, m.selectedProvider)
	mcp.DecideAndApply(m.registry, provider.BaseURL, provider.Protocol, config.GetContextWindow(&provider), m.MCPLoading)
	message := fmt.Sprintf("Provider switched to %s · %s.", provider.Name, provider.Model)
	if msg.modelOnly {
		message = fmt.Sprintf("Model set to %s and saved.", provider.Model)
		if err := config.PersistModel(provider.BaseURL, provider.Model); err != nil {
			m.activityError = fmt.Sprintf("Model switched but saving failed: %s", err)
			message = fmt.Sprintf("Model set to %s for this session.", provider.Model)
		}
	}
	m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: message})
	return m, m.commitStaticOutput()
}
