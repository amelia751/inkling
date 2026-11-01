// Package server is the HTTP layer: chi router, middleware and the strict
// handlers generated from schemas/versioning/openapi.yaml.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"studio.local/versioning/internal/api"
	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/service"
)

// Options configure the router.
type Options struct {
	Handlers         *Handlers
	Verifier         *authn.Verifier
	Log              *slog.Logger
	MaxBodyBytes     int64
	MaxArtifactBytes int64
	RequestTimeout   time.Duration
	UploadTimeout    time.Duration
}

type ctxKey int

const (
	keyContentLength ctxKey = iota
	keyRequestID
)

func contentLength(ctx context.Context) int64 {
	n, ok := ctx.Value(keyContentLength).(int64)
	if !ok {
		return -1
	}
	return n
}

// New builds the HTTP handler.
func New(o Options) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID, requestContext, recoverer(o.Log), accessLog(o.Log))
	r.Use(func(next http.Handler) http.Handler {
		return otelhttp.NewHandler(next, "versioning", otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string {
			return r.Method + " " + r.URL.Path
		}))
	})
	r.Use(limits(o), authenticate(o.Verifier), pipelineScope)
	strict := api.NewStrictHandlerWithOptions(o.Handlers, nil, api.StrictHTTPServerOptions{
		RequestErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			writeProblem(w, r, &service.Error{Status: http.StatusBadRequest, Code: "bad_request", Detail: err.Error()})
		},
		ResponseErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) { writeError(w, r, o.Log, err) },
	})
	return api.HandlerWithOptions(strict, api.ChiServerOptions{BaseRouter: r,
		ErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			writeProblem(w, r, &service.Error{Status: http.StatusBadRequest, Code: "bad_request", Detail: err.Error()})
		}})
}

func requestContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), keyContentLength, r.ContentLength)
		ctx = context.WithValue(ctx, keyRequestID, middleware.GetReqID(r.Context()))
		w.Header().Set("X-Request-Id", middleware.GetReqID(r.Context()))
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func isUpload(r *http.Request) bool {
	return r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/internal/v1/artifacts/")
}

// limits applies the body-size cap and per-route timeouts (spec §14).
func limits(o Options) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			maxBytes, timeout := o.MaxBodyBytes, o.RequestTimeout
			if isUpload(r) {
				maxBytes, timeout = o.MaxArtifactBytes, o.UploadTimeout
			}
			if r.ContentLength > maxBytes {
				writeProblem(w, r, &service.Error{Status: http.StatusRequestEntityTooLarge, Code: "too_large", Detail: "request body too large"})
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			ctx, cancel := context.WithTimeout(r.Context(), timeout)
			defer cancel()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// authenticate verifies the service JWT on every /internal route.
func authenticate(v *authn.Verifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasPrefix(r.URL.Path, "/internal/") {
				next.ServeHTTP(w, r)
				return
			}
			tok, ok := authn.BearerToken(r.Header.Get("Authorization"))
			if !ok {
				writeProblem(w, r, &service.Error{Status: http.StatusUnauthorized, Code: "unauthenticated", Detail: "bearer token required"})
				return
			}
			p, err := v.Verify(tok)
			if err != nil {
				writeProblem(w, r, &service.Error{Status: http.StatusUnauthorized, Code: "unauthenticated", Detail: "invalid token"})
				return
			}
			if p.RequestID == "" {
				p.RequestID = middleware.GetReqID(r.Context())
			}
			next.ServeHTTP(w, r.WithContext(authn.WithPrincipal(r.Context(), p)))
		})
	}
}

func recoverer(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() { //nolint:contextcheck // writes the response for this request; no new work is started
				if v := recover(); v != nil {
					if v == http.ErrAbortHandler {
						panic(v)
					}
					log.Error("panic", "request_id", middleware.GetReqID(r.Context()), "panic", v, "stack", string(debug.Stack()))
					writeProblem(w, r, &service.Error{Status: http.StatusInternalServerError, Code: "internal", Detail: "internal error"})
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// accessLog logs method, route, status and request id; never bodies.
func accessLog(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			start := time.Now()
			next.ServeHTTP(ww, r)
			if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
				return
			}
			log.Info("request", "request_id", middleware.GetReqID(r.Context()), "method", r.Method,
				"route", chi.RouteContext(r.Context()).RoutePattern(), "status", ww.Status(),
				"bytes", ww.BytesWritten(), "duration_ms", time.Since(start).Milliseconds())
		})
	}
}

func writeError(w http.ResponseWriter, r *http.Request, log *slog.Logger, err error) {
	var se *service.Error
	switch {
	case errors.As(err, &se):
		writeProblem(w, r, se)
	case errors.Is(err, context.DeadlineExceeded):
		writeProblem(w, r, &service.Error{Status: http.StatusGatewayTimeout, Code: "internal", Detail: "request timed out"})
	case errors.Is(err, authn.ErrUnauthenticated):
		writeProblem(w, r, &service.Error{Status: http.StatusUnauthorized, Code: "unauthenticated", Detail: "unauthenticated"})
	default:
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeProblem(w, r, &service.Error{Status: http.StatusRequestEntityTooLarge, Code: "too_large", Detail: "request body too large"})
			return
		}
		log.Error("request failed", "request_id", middleware.GetReqID(r.Context()), "error", err)
		writeProblem(w, r, &service.Error{Status: http.StatusInternalServerError, Code: "internal", Detail: "internal error"})
	}
}

func writeProblem(w http.ResponseWriter, r *http.Request, e *service.Error) {
	rid := middleware.GetReqID(r.Context())
	p := api.Problem{Type: "about:blank", Title: http.StatusText(e.Status), Status: e.Status, Code: api.ProblemCode(e.Code),
		Detail: strp(e.Detail), RequestId: strp(rid), CurrentHead: strp(e.CurrentHead)}
	if e.Generation != 0 {
		p.HeadGeneration = &e.Generation
	}
	if len(e.Problems) > 0 {
		p.Problems = &e.Problems
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(e.Status)
	_ = json.NewEncoder(w).Encode(p)
}
