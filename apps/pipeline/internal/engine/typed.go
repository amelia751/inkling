package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// Typed adapts a typed workflow body to a WorkflowFunc (JSON in, JSON out).
func Typed[P, R any](fn func(ctx Context, input P) (R, error)) WorkflowFunc {
	return func(ctx Context, raw json.RawMessage) (json.RawMessage, error) {
		var in P
		if len(raw) > 0 && string(raw) != "null" {
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, fmt.Errorf("decode workflow input: %w", err)
			}
		}
		out, err := fn(ctx, in)
		if err != nil {
			return nil, err
		}
		return json.Marshal(out)
	}
}

// Step runs a typed step: Step(ctx, "load-plan", func(ctx context.Context) (Plan, error) {…}).
func Step[R any](ctx Context, name string, fn func(context.Context) (R, error), opts ...StepOption) (R, error) {
	var zero R
	raw, err := ctx.Step(name, func(c context.Context) (json.RawMessage, error) {
		v, err := fn(c)
		if err != nil {
			return nil, err
		}
		return json.Marshal(v)
	}, opts...)
	if err != nil {
		return zero, err
	}
	return Decode[R](raw)
}

// Recv waits for a typed message. ok is false on timeout.
func Recv[T any](ctx Context, topic string, timeout time.Duration) (T, bool, error) {
	var zero T
	raw, ok, err := ctx.Recv(topic, timeout)
	if err != nil || !ok {
		return zero, ok, err
	}
	v, err := Decode[T](raw)
	return v, true, err
}

// Input encodes a start input.
func Input(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("engine.Input: %v", err))
	}
	return b
}

// Decode decodes a JSON result; empty or null decodes to the zero value.
func Decode[T any](raw json.RawMessage) (T, error) {
	var v T
	if len(raw) == 0 || string(raw) == "null" {
		return v, nil
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return v, fmt.Errorf("decode engine value: %w", err)
	}
	return v, nil
}
