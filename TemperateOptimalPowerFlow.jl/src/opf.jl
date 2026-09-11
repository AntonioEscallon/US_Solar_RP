export opf, partitioned_opf, compute


function opf(quadratic_cost::AbstractArray{<:Real,2}, linear_cost::AbstractArray{<:Real,2},
        P_max::AbstractVector{<:Real}, P_exp::AbstractVector{<:Real},
        P_total::AbstractVector{<:Real}; P_min::AbstractVector{<:Real} = Real[],
        A_ramp::AbstractArray{<:Real,2} = Array{Real}(undef, 0, 0),
        ΔP_ramp::AbstractVector{<:Real} = Real[],
        P_ramp_first::AbstractVector{<:Real} = Real[], P_ramp_last::AbstractVector{<:Real} = Real[],
        log_group::String = "", retry::Bool = true, debug::Bool = true, silent::Bool = true)

    N = length(P_max)
    T = length(P_total)
    n_ramp = length(ΔP_ramp)

    if length(P_min) == 0
        P_min = zeros(N)
    end

    # check dimensions of the input
    @assert length(P_exp) == N
    @assert length(P_min) == N
    @assert size(quadratic_cost) == (N, N)
    @assert size(linear_cost) == (N, T)
    @assert (size(A_ramp) == (n_ramp, N)) || (n_ramp == 0)
    @assert length(P_ramp_first) ∈ [0, n_ramp]
    @assert length(P_ramp_last) == length(P_ramp_first)

    if n_ramp == 0
        @info "OPF with $T time steps and $N generators" _group = log_group
    else
        ramp_constraint_type = length(P_ramp_first) == 0 ? "cyclic" : "fixed boundaries"
        @info ("OPF with $T time steps, $N generators, " *
            "and $n_ramp ramp constraints ($ramp_constraint_type)") _group = log_group
    end
    log_group = " "^length(log_group)

    # check feasibility of the model
    @info " -> checking model" _group = log_group
    @assert all(P_exp .<= P_max)
    @assert all(ΔP_ramp .>= 0)
    @assert all(P_total .<= sum(P_max))
    @assert abs(sum(P_total) / sum(P_exp) / T - 1) < 1e-2

    optimizer = silent ? get_silent_optimizer() : get_optimizer()

    @info " -> defining optimization problem" _group = log_group
    # variables
    P_vec = MOI.add_variables(optimizer, N * T)
    P = reshape(P_vec, (N, T))

    # constraints
    MOI.add_constraints(optimizer, P_vec, [MOI.Interval(P_min[i], P_max[i])
        for t = 1:T for i = 1:N])

    MOI.add_constraints(optimizer,
        [MOI.ScalarAffineFunction([MOI.ScalarAffineTerm(1.0, P[i,t]) for t = 1:T], 0.0)
            for i = 2:N],
        [MOI.EqualTo(T * P_exp[i]) for i = 2:N])

    MOI.add_constraints(optimizer,
        [MOI.ScalarAffineFunction([MOI.ScalarAffineTerm(1.0, P[i,t]) for i = 1:N], 0.0)
            for t = 1:T],
        [MOI.EqualTo(P_total[t]) for t = 1:T])

    if n_ramp > 0
        P_ramp = A_ramp * P
        if length(P_ramp_first) == 0
            ΔP = [P_ramp[n, t] - P_ramp[n, t % T + 1] for t = 1:T for n = 1:n_ramp]
            MOI.add_constraints(optimizer, ΔP, [MOI.GreaterThan(-ΔP_ramp[n])
                for t = 1:T for n = 1:n_ramp])
            MOI.add_constraints(optimizer, ΔP, [MOI.LessThan(ΔP_ramp[n])
                for t = 1:T for n = 1:n_ramp])
        else
            ΔP = [P_ramp[n, t] - P_ramp[n, t + 1] for t = 1:T-1 for n = 1:n_ramp]
            MOI.add_constraints(optimizer, ΔP, [MOI.GreaterThan(-ΔP_ramp[n])
                for t = 1:T-1 for n = 1:n_ramp])
            MOI.add_constraints(optimizer, ΔP, [MOI.LessThan(ΔP_ramp[n])
                for t = 1:T-1 for n = 1:n_ramp])
            P_first = [P_ramp[n, 1] for n = 1:n_ramp]
            MOI.add_constraints(optimizer, P_first, [MOI.GreaterThan(P_ramp_first[n] - ΔP_ramp[n])
                for n = 1:n_ramp])
            MOI.add_constraints(optimizer, P_first, [MOI.LessThan(P_ramp_first[n] + ΔP_ramp[n])
                for n = 1:n_ramp])
            P_last = [P_ramp[n, T] for n = 1:n_ramp]
            MOI.add_constraints(optimizer, P_last, [MOI.GreaterThan(P_ramp_last[n] - ΔP_ramp[n])
                for n = 1:n_ramp])
            MOI.add_constraints(optimizer, P_last, [MOI.LessThan(P_ramp_last[n] + ΔP_ramp[n])
                for n = 1:n_ramp])
        end
    end

    quadratic_terms = vcat(
        [MOI.ScalarQuadraticTerm(2.0 * quadratic_cost[i,i], P[i, t], P[i, t])
            for i = 1:N for t = 1:T],
        [MOI.ScalarQuadraticTerm(quadratic_cost[i,j], P[i, t], P[j, t])
            for i = 1:N for j = (i+1):N for t = 1:T]
    )
    affine_terms = [MOI.ScalarAffineTerm(linear_cost[i, t], P[i, t]) for i = 1:N for t = 1:T]
    objective = MOI.ScalarQuadraticFunction(quadratic_terms, affine_terms, 0.0)

    MOI.set(optimizer, MOI.ObjectiveFunction{MOI.ScalarQuadraticFunction{Float64}}(), objective)
    MOI.set(optimizer, MOI.ObjectiveSense(), MOI.MIN_SENSE)

    @info " -> optimizing" _group = log_group
    MOI.optimize!(optimizer)

    if MOI.get(optimizer, MOI.ResultCount()) == 1
        @info " -> exporting results" _group = log_group
        P_vec_solution = MOI.get(optimizer, MOI.VariablePrimal(), P_vec)
        P_solution = reshape(P_vec_solution, (N, T))

        return P_solution
    end

    status = MOI.get(optimizer, MOI.TerminationStatus())
    @warn "OPF did not converge: termination status $status" _group = log_group

    if debug
        @info " -> exporting debug data" _group = log_group
        try
            DataDrop.store_matrix("debug_quadratic_cost.h5", quadratic_cost)
            DataDrop.store_matrix("debug_linear_cost.h5", linear_cost)
            DataDrop.store_matrix("debug_P_max.h5", P_max)
            DataDrop.store_matrix("debug_P_exp.h5", P_exp)
            DataDrop.store_matrix("debug_P_total.h5", P_total)
            DataDrop.store_matrix("debug_P_min.h5", P_min)
            DataDrop.store_matrix("debug_A_ramp.h5", A_ramp)
            DataDrop.store_matrix("debug_P_ramp.h5", ΔP_ramp)
            if length(P_ramp_first) > 0
                DataDrop.store_matrix("debug_P_ramp_first.h5", P_ramp_first)
                DataDrop.store_matrix("debug_P_ramp_last.h5", P_ramp_last)
            end
        catch
            @warn "Failed to export debug data" _group = log_group
        end
    end

    if retry
        @info " -> second attempt" _group = log_group
        return opf(quadratic_cost, linear_cost, P_max, P_exp, P_total, P_min = P_min,
            A_ramp = A_ramp, ΔP_ramp = ΔP_ramp,
            P_ramp_first = P_ramp_first, P_ramp_last = P_ramp_last,
            log_group = log_group, retry = false, debug = false)
    end

    throw(ErrorException("OPF did not converge"))
end


function partitioned_opf(partitions::Vector{Int},
        quadratic_cost::AbstractArray{<:Real,2}, linear_cost::AbstractArray{<:Real,2},
        P_max::AbstractVector{<:Real}, P_exp::AbstractVector{<:Real},
        P_total::AbstractVector{<:Real}; P_min::AbstractVector{<:Real} = Real[],
        A_ramp::AbstractArray{<:Real,2} = Array{Real}(undef, 0, 0),
        ΔP_ramp::AbstractVector{<:Real} = Real[],
        P_ramp_first::AbstractVector{<:Real} = Real[], P_ramp_last::AbstractVector{<:Real} = Real[],
        P_bounds_factor::Real = 0.1, log_group::String = "",
        retry::Bool = true, debug::Bool = true)

    if length(partitions) <= 1
        return opf(quadratic_cost, linear_cost, P_max, P_exp, P_total, P_min = P_min,
            A_ramp = A_ramp, ΔP_ramp = ΔP_ramp,
            P_ramp_first = P_ramp_first, P_ramp_last = P_ramp_last,
            log_group = log_group, retry = retry, debug = debug)
    end

    N = length(P_max)
    T = length(P_total)
    n_ramp = length(ΔP_ramp)

    if length(P_min) == 0
        P_min = zeros(N)
    end

    # check dimensions of the input that needs to be partitioned
    @assert length(P_exp) == N
    @assert length(P_min) == N
    @assert size(quadratic_cost) == (N, N)
    @assert size(linear_cost) == (N, T)
    @assert (size(A_ramp) == (n_ramp, N)) || (n_ramp == 0)

    # check that the number of partitions matches the total number of steps
    @assert prod(partitions) == T
    @assert (P_bounds_factor >= 0) && (P_bounds_factor < 1)

    n_partitions = partitions[1]
    partition_length = T ÷ n_partitions

    counter_width = length(string(n_partitions))
    @info ("Partitioning a dataset of $T time steps into $n_partitions chunks "
        * "of $partition_length time steps") _group = log_group

    partitioned_P_total = reshape(P_total, (partition_length, n_partitions))
    aggregated_P_total = dropdims(sum(partitioned_P_total, dims=1), dims=1) / partition_length

    partitioned_linear_cost = reshape(linear_cost, (N, partition_length, n_partitions))
    aggregated_linear_cost = dropdims(sum(partitioned_linear_cost, dims=2),
        dims=2) / partition_length

    aggregated_P_max = (1.0 - P_bounds_factor) * P_max + P_bounds_factor * P_exp
    aggregated_P_min = (1.0 - P_bounds_factor) * P_min + P_bounds_factor * P_exp

    partitioned_P_exp = opf(quadratic_cost, aggregated_linear_cost, aggregated_P_max, P_exp,
        aggregated_P_total, P_min = aggregated_P_min, A_ramp = A_ramp, ΔP_ramp = ΔP_ramp,
        P_ramp_first = P_ramp_first, P_ramp_last = P_ramp_last,
        log_group = log_group * " $(lpad(0, counter_width))/$(n_partitions)",
        retry = retry, debug = debug)

    partitioned_P_ramp = n_ramp > 0 ? A_ramp * partitioned_P_exp : Real[]

    result = Matrix{Float64}(undef, N, 0)
    timing = []
    for a=1:n_partitions

        GC.gc()

        if length(timing) > 0
            estimated_remaining_time = "Estimated remaining time:"
            s = round(Int, (n_partitions - a + 1) * sum(timing) / length(timing))
            if s >= 60
                m = s ÷ 60
                s = s % 60
                if m >= 60
                    h = m ÷ 60
                    m = m % 60
                    estimated_remaining_time = estimated_remaining_time * " $h h"
                end
                estimated_remaining_time = estimated_remaining_time * " $m min"
            end
            estimated_remaining_time = estimated_remaining_time * " $s s"
            @info estimated_remaining_time _group = log_group
        end

        if n_ramp == 0
            partitioned_P_ramp_previous = Real[]
            partitioned_P_ramp_next = Real[]
        else
            if a == 1
                partitioned_P_ramp_previous = (length(P_ramp_first) > 0
                    ? P_ramp_first : partitioned_P_ramp[:, end])
            else
                partitioned_P_ramp_previous = partitioned_P_ramp[:, a - 1]
            end
            if a == n_partitions
                partitioned_P_ramp_next = (length(P_ramp_last) > 0
                    ? P_ramp_last : partitioned_P_ramp[:, 1])
            else
                partitioned_P_ramp_next = partitioned_P_ramp[:, a + 1]
            end
        end

        partition_result = @timed partitioned_opf(partitions[2:end], quadratic_cost,
            partitioned_linear_cost[:,:,a], P_max, partitioned_P_exp[:,a], partitioned_P_total[:,a],
            P_min = P_min, A_ramp = A_ramp, ΔP_ramp = ΔP_ramp,
            P_ramp_first = partitioned_P_ramp_previous, P_ramp_last = partitioned_P_ramp_next,
            log_group = log_group * " $(lpad(a, counter_width))/$(n_partitions)",
            retry = retry, debug = debug)
        push!(timing, partition_result.time)
        result = hcat(result, partition_result.value)
    end

    return result
end


function compute(directory::String, result_file::String = "P_result",
        partitions::AbstractVector{<:Integer} = Integer[], noise_factor::Real = 1; kwargs...)
    quadratic_cost = DataDrop.retrieve_matrix("$directory/quadratic_cost.h5")
    line_cost      = DataDrop.retrieve_matrix("$directory/linear_line_cost.h5")
    gen_cost       = DataDrop.retrieve_matrix("$directory/linear_gen_cost.h5")
    P_max          = DataDrop.retrieve_matrix("$directory/P_max.h5")
    P_exp          = DataDrop.retrieve_matrix("$directory/P_exp.h5")
    P_total        = DataDrop.retrieve_matrix("$directory/P_total.h5")

    if isfile("$directory/A_ramp.h5") && isfile("$directory/ramp_max.h5")
        A_ramp  = DataDrop.retrieve_matrix("$directory/A_ramp.h5")
        ΔP_ramp = DataDrop.retrieve_matrix("$directory/ramp_max.h5")
    else
        A_ramp  = Array{Real}(undef, 0, 0)
        ΔP_ramp = Real[]
    end

    linear_cost = line_cost + noise_factor * gen_cost

    result = (length(partitions) == 0
        ? opf(quadratic_cost, linear_cost,
            P_max, P_exp, P_total; A_ramp = A_ramp, ΔP_ramp = ΔP_ramp, kwargs...)
        : partitioned_opf(partitions, quadratic_cost, linear_cost,
            P_max, P_exp, P_total; A_ramp = A_ramp, ΔP_ramp = ΔP_ramp, kwargs...)
        )

    if occursin(".h5", result_file) == false
        result_file = result_file * ".h5"
    end
    if occursin("/", result_file) == false
        result_file = "$directory/" * result_file
    end

    @info ("Saving results to file '$(result_file)'") _group = ""
    DataDrop.store_matrix(result_file, result)

    nothing
end